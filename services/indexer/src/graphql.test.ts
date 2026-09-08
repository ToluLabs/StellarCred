import request from "supertest";
import type { Application } from "express";
import { buildApp } from "./api";
import { createSqliteDb } from "./db";
import type { Db } from "./db";
import type { Config } from "./config";
import type { Ingester, IngesterHealth } from "./ingester";

import os from "os";
import path from "path";
import fs from "fs";

let db: Db;
let app: Application;
let tmpFile: string;

function makeIngester(overrides?: Partial<IngesterHealth>): Ingester {
  const health: IngesterHealth = {
    lastSuccessLedger: 0,
    headLedger: 0,
    lag: -1,
    lastError: null,
    lastErrorTime: null,
    consecutiveErrors: 0,
    fetchAttempts: 0,
    fetchFailures: 0,
    ...overrides,
  };
  return {
    tick: async () => 0,
    reconcile: async () => 0,
    start: () => {},
    stop: () => {},
    getHealth: () => ({ ...health }),
  };
}

function makeConfig(sqlitePath: string): Config {
  return {
    stellarNetwork: "testnet",
    horizonUrl: "https://horizon-testnet.stellar.org",
    rpcUrl: "https://soroban-testnet.stellar.org",
    proofRegistryContractId: "CTEST",
    dbDriver: "sqlite",
    sqlitePath,
    databaseUrl: undefined,
    pollIntervalMs: 6000,
    startLedger: 0,
    port: 3001,
    finalityLag: 6,
    corsOrigins: ["http://localhost:3000"],
    rateLimitWindowMs: 60000,
    rateLimitMax: 120,
    rateLimitEnabled: true,
  };
}

beforeEach(() => {
  tmpFile = path.join(os.tmpdir(), `indexer-gql-test-${Date.now()}-${Math.random()}.db`);
  db = createSqliteDb(makeConfig(tmpFile));
  db.migrate();
  app = buildApp(db, makeIngester());
});

afterEach(() => {
  db.close();
  try { fs.unlinkSync(tmpFile); } catch {}
  try { fs.unlinkSync(tmpFile + "-wal"); } catch {}
  try { fs.unlinkSync(tmpFile + "-shm"); } catch {}
});

function seedClaims(dbs: ReturnType<typeof createSqliteDb>) {
  const base = {
    issuer: "GISSUER",
    expiry: 9999999,
    threshold: null,
    revoked: 0,
  };
  dbs.upsertClaim({ ...base, wallet: "GA1", credential_type: "kyc", verified_at: 1000, ledger_sequence: 1 });
  dbs.upsertClaim({ ...base, wallet: "GA2", credential_type: "kyc", verified_at: 2000, ledger_sequence: 2 });
  dbs.upsertClaim({ ...base, wallet: "GA3", credential_type: "age", verified_at: 3000, ledger_sequence: 3 });
  dbs.upsertClaim({ ...base, wallet: "GA4", credential_type: "kyc", verified_at: 4000, ledger_sequence: 4 });
}

describe("POST /graphql claims query", () => {
  it("returns claims filtered by wallet", async () => {
    seedClaims(db as ReturnType<typeof createSqliteDb>);
    const q = `query($wallet: String){ claims(wallet: $wallet){ claims { wallet credential_type } total } }`;
    const res = await request(app)
      .post("/graphql")
      .send({ query: q, variables: { wallet: "GA2" } })
      .set("Content-Type", "application/json");
    expect(res.status).toBe(200);
    expect(res.body.data.claims.total).toBe(1);
    expect(res.body.data.claims.claims[0].wallet).toBe("GA2");
  });

  it("filters by credential_type and active status", async () => {
    seedClaims(db as ReturnType<typeof createSqliteDb>);
    // revoke GA4's kyc
    (db as ReturnType<typeof createSqliteDb>).revokeClaim("GA4", "kyc");

    const q = `query($type: String, $active: Boolean){ claims(credential_type: $type, active: $active){ claims { wallet credential_type revoked } total } }`;
    const resActive = await request(app)
      .post("/graphql")
      .send({ query: q, variables: { type: "kyc", active: true } })
      .set("Content-Type", "application/json");
    expect(resActive.status).toBe(200);
    expect(resActive.body.data.claims.total).toBe(2); // GA1, GA2

    const resRevoked = await request(app)
      .post("/graphql")
      .send({ query: q, variables: { type: "kyc", active: false } })
      .set("Content-Type", "application/json");
    expect(resRevoked.status).toBe(200);
    expect(resRevoked.body.data.claims.total).toBe(1); // GA4
    expect(resRevoked.body.data.claims.claims[0].revoked).toBe(1);
  });

  it("supports verified time range and pagination (limit/offset)", async () => {
    seedClaims(db as ReturnType<typeof createSqliteDb>);
    const q = `query($from:Int,$to:Int,$limit:Int,$offset:Int){ claims(verifiedFrom:$from, verifiedTo:$to, limit:$limit, offset:$offset){ claims { wallet verified_at } total } }`;
    const res = await request(app)
      .post("/graphql")
      .send({ query: q, variables: { from: 1500, to: 4500, limit: 2, offset: 0 } })
      .set("Content-Type", "application/json");
    expect(res.status).toBe(200);
    // Matching wallets GA2 (2000), GA3 (3000), GA4 (4000) => total 3, but limit 2
    expect(res.body.data.claims.total).toBe(3);
    expect(res.body.data.claims.claims).toHaveLength(2);
  });
});
