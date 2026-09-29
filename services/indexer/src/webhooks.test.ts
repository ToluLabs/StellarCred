import { createHmac } from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { createSqliteDb } from "./db";
import type { Config } from "./config";
import { createWebhookDispatcher } from "./webhooks";

function makeConfig(sqlitePath: string): Config {
  return {
    stellarNetwork: "testnet",
    horizonUrl: "https://horizon-testnet.stellar.org",
    rpcUrl: "https://soroban-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
    proofRegistryContractId: "CTEST",
    dbDriver: "sqlite",
    sqlitePath,
    databaseUrl: undefined,
    pollIntervalMs: 6000,
    startLedger: 0,
    port: 3001,
    finalityLag: 6,
    corsOrigins: [],
    rateLimitWindowMs: 60000,
    rateLimitMax: 120,
    rateLimitEnabled: true,
  };
}

describe("claim lifecycle webhooks", () => {
  let db: ReturnType<typeof createSqliteDb>;
  let tmpFile: string;

  beforeEach(async () => {
    tmpFile = path.join(os.tmpdir(), `webhooks-${process.pid}-${Date.now()}-${Math.random()}.db`);
    db = createSqliteDb(makeConfig(tmpFile));
    await db.migrate();
  });

  afterEach(async () => {
    await db.close();
    for (const file of [tmpFile, `${tmpFile}-wal`, `${tmpFile}-shm`]) {
      try {
        fs.unlinkSync(file);
      } catch {
        // SQLite may not create every sidecar file.
      }
    }
  });

  it("queues, signs, and marks an expiry notification delivered", async () => {
    const secret = "test-signing-secret-123456789012";
    const now = 1_800_000_000;
    await db.createWebhookSubscription({
      url: "https://protocol.example/events",
      wallet: "GALICE",
      credential_type: "kyc",
    });
    await db.upsertClaim({
      wallet: "GALICE",
      credential_type: "kyc",
      issuer: "GISSUER",
      verified_at: 1_700_000_000,
      expiry: now - 10,
      ledger_sequence: 42,
      threshold: null,
      revoked: 0,
    });

    let captured:
      | { body: string; timestamp: string; signature: string }
      | undefined;
    const dispatcher = createWebhookDispatcher(db, secret, {
      now: () => now,
      send: async (_url, body, timestamp, signature) => {
        captured = { body, timestamp, signature };
      },
    });

    expect(await dispatcher.enqueueExpiredClaims()).toBe(1);
    expect(await dispatcher.dispatchPending()).toBe(1);
    expect(captured).toBeDefined();
    expect(captured?.body).toContain('"type":"claim.expired"');
    expect(captured?.body).toContain('"reasonCode":"credential_expired"');
    const expected = `sha256=${createHmac("sha256", secret)
      .update(`${now}.${captured?.body}`)
      .digest("hex")}`;
    expect(captured?.signature).toBe(expected);
    expect(captured?.timestamp).toBe(String(now));

    const subscription = (await db.listWebhookSubscriptions())[0];
    const history = await db.webhookDeliveries(subscription!.id, 10);
    expect(history[0]).toMatchObject({ attempts: 1, delivered_at: now, last_error: null });

    await dispatcher.enqueueExpiredClaims();
    expect(await db.pendingWebhookDeliveries(now, 10, 8)).toHaveLength(0);
  });

  it("retries failed deliveries with exponential backoff", async () => {
    let now = 1_800_000_000;
    let sends = 0;
    await db.createWebhookSubscription({
      url: "https://protocol.example/events",
      wallet: "GALICE",
      credential_type: "kyc",
    });
    await db.enqueueWebhookEvent({
      event_id: "revoked:tx:GALICE:kyc",
      type: "revoked",
      wallet: "GALICE",
      credential_type: "kyc",
      expiry: now + 10_000,
      ledger_sequence: 42,
      occurred_at: now,
      reason_code: "issuer_revoked",
    });
    const dispatcher = createWebhookDispatcher(db, "test-signing-secret-123456789012", {
      now: () => now,
      send: async () => {
        sends += 1;
        if (sends === 1) throw new Error("receiver unavailable");
      },
    });

    await dispatcher.dispatchPending();
    expect(await db.pendingWebhookDeliveries(now, 10, 8)).toHaveLength(0);
    now += 5;
    expect(await dispatcher.dispatchPending()).toBe(1);
    const subscription = (await db.listWebhookSubscriptions())[0];
    expect(await db.webhookDeliveries(subscription!.id, 10)).toMatchObject([
      expect.objectContaining({
        attempts: 2,
        delivered_at: now,
        last_error: null,
      }),
    ]);
  });
});
