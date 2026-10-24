# fixtures/indexer/

Representative contract event fixtures for the indexer test suite (`services/indexer/tests/indexer.test.ts`).

These JSON files are **auto-generated on first test run** if they don't already exist. They represent the raw Horizon `GET /contracts/{id}/events` response records that the ingester parses.

## Files

| File | Description |
|------|-------------|
| `verified-event.json` | A ProofRegistry `proof:verified` event. Topics: `[ScvSymbol("proof"), ScvSymbol("verified"), ScvSymbol("kyc")]`; value: `ScvU64(expiry)`. |
| `revoked-event.json`  | A ProofRegistry `revoked` event. Topics: `[ScvSymbol("revoked")]`; value: `ScvVec([holder, type, issuer, ts])`. |
| `unknown-event.json`  | An event from a different contract — the ingester must silently ignore it. |

## Regenerating

Delete any file and re-run the tests:

```bash
cd services/indexer
npm test -- --testPathPattern=tests/indexer
```

## Adding a fixture

1. Copy a real Horizon event record from `/contracts/{id}/events`.
2. Save it as a JSON file here.
3. Reference it in `tests/indexer.test.ts` using:
   ```ts
   const ev = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, "my-event.json"), "utf8"));
   ```
