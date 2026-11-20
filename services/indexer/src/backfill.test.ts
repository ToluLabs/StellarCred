import fs from "fs";
import os from "os";
import path from "path";
import type { Config } from "./config";
import type { Db } from "./db";
import { parseBackfillArgs, readCheckpoint, runBackfill, type BackfillOptions } from "./backfill";
import * as ingester from "./ingester";

const CONTRACT = "CCONTRACT";

const config = {
  horizonUrl: "https://horizon.test",
  proofRegistryContractId: CONTRACT,
  startLedger: 0,
  finalityLag: 6,
} as unknown as Config;

type Ev = { paging_token: string; ledger: number; contract_id: string; topic: string[]; value: string; ledger_closed_at: string };

const ev = (ledger: number, i = 0): Ev => ({
  paging_token: `${ledger}-${i}`,
  ledger,
  contract_id: CONTRACT,
  topic: [],
  value: "",
  ledger_closed_at: "2026-01-01T00:00:00Z",
});

const makeDb = () => {
  const db = {
    upsertClaim: jest.fn(),
    revokeClaim: jest.fn(),
    getLastLedger: jest.fn(),
    setLastLedger: jest.fn(),
    enqueueWebhookEvent: jest.fn(),
  };
  return { db, asDb: db as unknown as Db };
};

/** Fake Horizon: head ledger plus an ordered event log paged by token. */
const makeHorizon = (head: number, events: Ev[], failOnCall?: number) => {
  let calls = 0;
  const fetchImpl = jest.fn(async (input: string) => {
    calls++;
    const url = new URL(input);
    if (url.pathname === "/ledgers") {
      return new Response(JSON.stringify({ _embedded: { records: [{ sequence: String(head) }] } }));
    }
    if (failOnCall !== undefined && calls === failOnCall) {
      return new Response("bad request", { status: 400 });
    }
    const limit = Number(url.searchParams.get("limit"));
    const cursor = url.searchParams.get("cursor");
    let start = 0;
    if (cursor && cursor.includes("-")) {
      start = events.findIndex((e) => e.paging_token === cursor) + 1;
    } else if (cursor) {
      const afterLedger = Number(cursor) / 100_000;
      start = events.findIndex((e) => e.ledger > afterLedger);
      if (start < 0) start = events.length;
    }
    return new Response(JSON.stringify({ _embedded: { records: events.slice(start, start + limit) } }));
  });
  return fetchImpl as unknown as typeof fetch;
};

const opts = (dir: string, over: Partial<BackfillOptions> = {}): BackfillOptions => ({
  from: 100,
  to: 200,
  batchSize: 2,
  resume: false,
  checkpointPath: path.join(dir, "cp.json"),
  ...over,
});

describe("parseBackfillArgs", () => {
  it("parses an explicit bounded range", () => {
    const o = parseBackfillArgs(["--from", "1000", "--to", "2000", "--batch-size", "50"]);
    expect(o).toMatchObject({ from: 1000, to: 2000, batchSize: 50, resume: false });
  });

  it("defaults to genesis..head", () => {
    expect(parseBackfillArgs([])).toMatchObject({ from: "genesis", to: "head" });
  });

  it("rejects an inverted range and bad batch sizes", () => {
    expect(() => parseBackfillArgs(["--from", "20", "--to", "10"])).toThrow(/must be <=/);
    expect(() => parseBackfillArgs(["--batch-size", "500"])).toThrow(/between 1 and 200/);
    expect(() => parseBackfillArgs(["--bogus"])).toThrow(/Unknown argument/);
  });
});

describe("runBackfill", () => {
  let dir: string;
  const log = jest.fn();
  const sleep = jest.fn(async () => undefined);

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "backfill-"));
    log.mockClear();
    jest.spyOn(ingester, "parseEvent").mockImplementation((e) => ({
      kind: "verified",
      holder: `G${e.paging_token}`,
      credentialType: "kyc",
      issuer: "GISSUER",
      expiry: 0,
      ledgerSequence: Number(e.ledger),
      verifiedAt: 0,
    }));
  });

  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("indexes only events inside the requested range", async () => {
    const { db, asDb } = makeDb();
    const events = [ev(90), ev(100), ev(150), ev(200), ev(250)];
    const res = await runBackfill(config, asDb, opts(dir), { fetchImpl: makeHorizon(1000, events), log, sleep });

    expect(res.processed).toBe(3);
    const ledgers = db.upsertClaim.mock.calls.map((c) => c[0].ledger_sequence);
    expect(ledgers).toEqual([100, 150, 200]);
  });

  it("caps the upper bound at the finality ceiling", async () => {
    const { db, asDb } = makeDb();
    const events = [ev(100), ev(195), ev(198)];
    const res = await runBackfill(config, asDb, opts(dir, { to: "head" }), { fetchImpl: makeHorizon(200, events), log, sleep });

    expect(res.to).toBe(194);
    expect(db.upsertClaim).toHaveBeenCalledTimes(1);
  });

  it("never touches the live cursor or the webhook queue", async () => {
    const { db, asDb } = makeDb();
    await runBackfill(config, asDb, opts(dir), { fetchImpl: makeHorizon(1000, [ev(120)]), log, sleep });

    expect(db.getLastLedger).not.toHaveBeenCalled();
    expect(db.setLastLedger).not.toHaveBeenCalled();
    expect(db.enqueueWebhookEvent).not.toHaveBeenCalled();
  });

  it("reports progress per batch and marks the checkpoint done", async () => {
    const { asDb } = makeDb();
    const events = [ev(100), ev(110), ev(120), ev(130), ev(140)];
    const res = await runBackfill(config, asDb, opts(dir), { fetchImpl: makeHorizon(1000, events), log, sleep });

    expect(res.batches).toBe(3);
    expect(log.mock.calls.filter((c) => String(c[0]).includes("] batch ")).length).toBe(3);
    expect(readCheckpoint(path.join(dir, "cp.json"))).toMatchObject({ done: true, processed: 5, lastLedger: 200 });
  });

  it("resumes an interrupted run without re-fetching completed batches", async () => {
    const events = [ev(100), ev(110), ev(120), ev(130), ev(140)];
    const first = makeDb();
    // Call 1 = head, call 2 = first page, call 3 fails with a non-retryable error.
    await expect(
      runBackfill(config, first.asDb, opts(dir), { fetchImpl: makeHorizon(1000, events, 3), log, sleep })
    ).rejects.toThrow(/400/);
    expect(first.db.upsertClaim).toHaveBeenCalledTimes(2);
    expect(readCheckpoint(path.join(dir, "cp.json"))).toMatchObject({ done: false, cursor: "110-0" });

    const second = makeDb();
    const res = await runBackfill(config, second.asDb, opts(dir, { resume: true }), {
      fetchImpl: makeHorizon(1000, events),
      log,
      sleep,
    });
    const ledgers = second.db.upsertClaim.mock.calls.map((c) => c[0].ledger_sequence);
    expect(ledgers).toEqual([120, 130, 140]);
    expect(res.processed).toBe(5);
  });

  it("refuses to start a new range over an unfinished checkpoint", async () => {
    const events = [ev(100), ev(110), ev(120)];
    await expect(
      runBackfill(config, makeDb().asDb, opts(dir), { fetchImpl: makeHorizon(1000, events, 3), log, sleep })
    ).rejects.toThrow();
    await expect(
      runBackfill(config, makeDb().asDb, opts(dir), { fetchImpl: makeHorizon(1000, events), log, sleep })
    ).rejects.toThrow(/--resume/);
  });

  it("retries transient Horizon errors before failing", async () => {
    const { asDb } = makeDb();
    let n = 0;
    const flaky = (async (input: string) => {
      const url = new URL(input);
      if (url.pathname === "/ledgers") {
        return new Response(JSON.stringify({ _embedded: { records: [{ sequence: "1000" }] } }));
      }
      n++;
      if (n === 1) return new Response("busy", { status: 503 });
      return new Response(JSON.stringify({ _embedded: { records: [ev(150)] } }));
    }) as unknown as typeof fetch;

    const res = await runBackfill(config, asDb, opts(dir), { fetchImpl: flaky, log, sleep });
    expect(res.processed).toBe(1);
    expect(sleep).toHaveBeenCalled();
  });
});
