# TypeScript quickstart (`@stellarcred/sdk`)

A minimal, compile-checked TypeScript example: typed claim reads, a signed
Stellar transaction verified through the SDK, and the recommended
challenge/claim authentication flow.

Full walkthrough: [`docs/SDK_TYPESCRIPT_EXAMPLE.md`](../../docs/SDK_TYPESCRIPT_EXAMPLE.md).

## Run it

```bash
npm install
npm run typecheck   # tsc --noEmit, the same check CI runs
npm start           # offline demo: builds, signs and verifies a transaction
```

`npm start` needs no network access and no configuration. To run a live
`ProofRegistry` read as well:

```bash
SC_CHECK_WALLET=G... npm start
```

## Dependencies

| Package | Why |
| --- | --- |
| `@stellarcred/sdk` | claim reads, signature and challenge verification |
| `@stellar/stellar-sdk` | peer dependency of the SDK; builds and signs the transaction |
| `typescript`, `tsx`, `@types/node` | typecheck and run the example |

See [`tsconfig.json`](./tsconfig.json) for the minimal strict configuration.
