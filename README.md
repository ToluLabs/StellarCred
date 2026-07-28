# StellarCred

[![CI](https://github.com/Psalmuel01/StellarCred/actions/workflows/ci.yml/badge.svg)](https://github.com/Psalmuel01/StellarCred/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![npm](https://img.shields.io/npm/v/@stellarcred/sdk?label=%40stellarcred%2Fsdk)](https://www.npmjs.com/package/@stellarcred/sdk)

**Privacy-preserving, reusable credentials for the Stellar ecosystem.**

A user holds a credential issued by a trusted party (KYC provider, bank,
government, employer), generates a zero-knowledge proof locally in the browser,
and submits it once on-chain. Any Stellar protocol can then check the result
with a single read-only contract call — **verify once, trusted everywhere** —
and the underlying credential data never touches the chain.

StellarCred is not a KYC app. It's the interoperability layer between issuers
and protocols: issuers integrate once, protocols integrate once, and users carry
reusable proofs instead of re-submitting personal data to every app.

---

## Highlights

- **Real on-chain ZK verification.** `CredentialVerifier` runs the host-native
  BN254 UltraHonk verifier ([`rs-soroban-ultrahonk`](https://github.com/yugocabrio/rs-soroban-ultrahonk)),
  not a stub. The full path — protocol → ProofRegistry → IssuerRegistry +
  CredentialVerifier → BN254 — is covered by **21 passing contract tests** over
  genuine proofs for all four credential types.
- **Issuer signature verified in zero-knowledge.** Each circuit verifies the
  issuer's secp256k1 ECDSA signature over the credential commitment
  (`std::ecdsa_secp256k1`) inside the proof, and the contract binds that key to
  the registered issuer — a proof only passes if a *registered* issuer actually
  signed the credential.
- **`is_verified` / `check_claim` are the on-chain primitives.** `is_verified` checks binary claims (kyc, jurisdiction); `check_claim(holder, type, min_threshold)` enforces numeric thresholds (age, income, funds) — a proof for ≥200k satisfies a ≥50k gate. One read, no API, no data handling.
- **Multi-claim issuance.** One verification issues every requested credential
  (KYC, age, jurisdiction, …) in a single call.
- **Drop-in integration.** The [`@stellarcred/sdk`](frontend/packages/sdk) gives
  protocols `hasClaim`, `getClaims`, and `buildVerifyUrl`, plus a return-URL
  redirect flow so users verify and bounce straight back.

---

## How it works

```
  Issuer  ──signs──▶  Credential  (held by the user, never on-chain)
 (KYC provider,            │
  bank, gov)               │  Noir circuit runs in the browser (WASM)
                           │  → UltraHonk proof + public inputs
                           ▼
  ┌──────────────────────────────────────────────────────────────┐
  │  Soroban contracts                                            │
  │                                                               │
  │   IssuerRegistry ──── trust root: which issuers, which types, │
  │                       and their signing public keys           │
  │   CredentialVerifier ─ stateless UltraHonk verify (VK / type) │
  │   ProofRegistry ────── caches "address X verified until T",   │
  │                       gated on the registered issuer key      │
  │   GatedPool ────────── demo DeFi pool gated on a KYC proof    │
  └──────────────────────────────────────────────────────────────┘
                           ▲
                           │  one read-only call: is_verified(wallet, claim)
                   Any protocol / the @stellarcred/sdk
```

**Issue → Prove → Verify.** The issuer computes `commitment = Poseidon2([value,
salt])` and signs it server-side. The holder generates a proof locally
(`noir_js` + `bb.js`) that proves knowledge of the preimage *and* the issuer's
signature, then calls `ProofRegistry.submit_proof`. The registry verifies the
proof once and caches the result; every protocol afterwards reads
`is_verified` instead of re-running the verifier.

---

## Architecture & Overview

For a detailed architectural description with diagrams, see the [Architecture Documentation](docs/ARCHITECTURE.md).

---

## Repository layout

```
contracts/              Soroban workspace (Rust, soroban-sdk 26)
  issuer_registry/        trust root; submit_proof checks is_valid_issuer
  credential_verifier/    real UltraHonk verify via host-native BN254 (VK per type)
  proof_registry/         caches verifications w/ expiry + TTL; gated on issuer key
  gated_pool/             demo DeFi pool gated on a KYC proof
circuits/               Noir circuits (UltraHonk · Noir 1.0.0-beta.9 / bb 0.87.0)
  commit/                 issuer helper: returns Poseidon2([value, salt], 2)
  kyc_proof/              "I hold a credential the issuer committed to"
  age_proof/              "I am over N" without revealing date of birth
  income_proof/           "my income exceeds T" without revealing it
  jurisdiction_proof/     "my country is not restricted" without revealing it
  funds_proof/            "my balance exceeds T" without revealing it
  scripts/build.sh        compile + prove + stage circuit JSON for the frontend
fixtures/<type>/        real vk / proof / public_inputs per type (contract tests)
frontend/               Next.js 14 app (App Router)
  app/                    landing, holder, verify, issuer, apps, developers, docs
  app/api/issue/          server-side credential issuance, via @stellarcred/issuer
  packages/sdk/           @stellarcred/sdk — hasClaim / getClaims / buildVerifyUrl
  packages/issuer/        @stellarcred/issuer — server-only issuance (value/salt/commitment/sig)
  lib/                    proof.ts (noir_js + bb.js), contracts.ts (stellar-sdk), wallet
scripts/deploy.sh       deploy + wire + register issuer + install all VKs on testnet
```

All five credential circuits share one commitment scheme,
`commitment = Poseidon2([value, salt], 2)`, so the issuer derives every
commitment with a single `commit` helper and each type is independently issuable
and provable.

---

## Integrating a protocol

Install the SDK:

```bash
npm install @stellarcred/sdk
```

> Full SDK docs: [`frontend/packages/sdk/README.md`](frontend/packages/sdk/README.md) · [npm](https://www.npmjs.com/package/@stellarcred/sdk)

Protocols never handle credential data - they ask the on-chain registry one
question: _has this wallet proven the claim I require?_

```ts
import { StellarCred } from "@stellarcred/sdk";

// Binary claim — KYC, jurisdiction
const canDeposit = await StellarCred.hasClaim(wallet, "kyc");

// Threshold claim — enforce minimum on-chain
const canAccessVault = await StellarCred.hasClaim(wallet, "funds", { minThreshold: 50000 });
const canTrade = await StellarCred.hasClaim(wallet, "age", { minThreshold: 21 });
const canAccessVault = await StellarCred.hasClaim(wallet, "funds", {
  minThreshold: 50000,
});
const canTrade = await StellarCred.hasClaim(wallet, "age", {
  minThreshold: 21,
});
```

If the user hasn't verified yet, send them to StellarCred and get them back
automatically:

```ts
const verifyUrl = StellarCred.buildVerifyUrl({
  returnUrl: "https://yourapp.xyz/deposit",
  claim: "kyc",
});
window.location.href = verifyUrl;
// StellarCred returns the user to returnUrl with ?sc_verified=true&sc_wallet=…
```

Two entry points, one backend:

- **User-first** — a user verifies at StellarCred before ever visiting your app;
  their credentials work everywhere immediately.
- **Protocol-first** — your app shows a "Verify" button, the user verifies, and
  returns automatically.

Prefer Soroban directly? Read `ProofRegistry.is_verified` from your own contract;
no SDK required. See [`/developers`](frontend/app/developers/page.tsx) for the
full reference.

---

## Credential types

| Claim          | Proves                       | Private input kept hidden |
| -------------- | ---------------------------- | ------------------------- |
| `kyc`          | Identity verified            | The credential secret     |
| `age`          | Age ≥ threshold              | Date of birth             |
| `income`       | Income ≥ threshold           | Actual income             |
| `jurisdiction` | Country not restricted       | Country code              |
| `funds`        | Balance ≥ threshold          | Exact balance (from Plaid)|

---

## Security model

1. **Issuer ↔ commitment binding is cryptographic.** The issuer signs the
   commitment with secp256k1; each circuit verifies that signature in-circuit
   (`std::ecdsa_secp256k1`) against the issuer public key (a public input), and
   `ProofRegistry` checks that public-input key equals the issuer's registered
   key. A proof is accepted only if a registered, trusted issuer actually signed
   the credential.
   - `prehash: false` is required when signing — Noir uses the raw 32-byte
     commitment as the message digest directly.
2. **The signing key is server-side only.** Issuance runs in the
   [`/api/issue`](frontend/app/api/issue/route.ts) route handler and signs with
   `ISSUER_PRIVATE_KEY` (never prefixed `NEXT_PUBLIC_`, never shipped to the
   browser). A production issuer would hold this key in an HSM or secrets
   manager. With no key set, the route runs a clearly-logged demo fallback.
3. **Attestation relay.** Issuance can be gated on a real KYC provider — the
   route integrates Persona's sandbox and only signs credentials after a positive
   result. Identity fields are sent once to the provider and never stored.
4. **Proof expiry.** `ProofRegistry` uses persistent storage with an explicit
   `expiry` (checked against ledger time) plus TTL extension.
5. **Contract upgradeability.** `ProofRegistry` supports an admin-controlled upgrade path using Soroban's native `update_current_contract_wasm` capability. The administrative key is initialized at deployment time and can be subsequently transferred to a multisig wallet or DAO.

---

## Prerequisites

- Rust (nightly ok) + the `wasm32v1-none` target: `rustup target add wasm32v1-none`
- Stellar CLI **v26+** to deploy (BN254 protocol); verified on 27.0.0
- Noir `nargo` **1.0.0-beta.9** (`noirup -v 1.0.0-beta.9`) and Barretenberg
  **bb v0.87.0** (`bbup -v 0.87.0`) — the versions must match or the VK won't validate
- Node 20+ and pnpm

---

## Build & test

```bash
# Contracts — real proof verification in tests
cargo test                 # 21 tests, incl. genuine BN254 verification
stellar contract build     # wasm artifacts → target/wasm32v1-none/release

# Circuits — compile, prove, and stage circuit JSON for the frontend
./circuits/scripts/build.sh                 # all circuits
./circuits/scripts/build.sh kyc_proof       # one

# Frontend
cd frontend && pnpm install && pnpm dev
```

---

## Deployments

A public record of deployed contract IDs on testnet and mainnet, along with instructions to verify the bytecode integrity from source, is maintained in [DEPLOYMENTS.md](DEPLOYMENTS.md).

---

## Run it end to end (testnet)

One-time toolchain (macOS):

```bash
brew install stellar-cli            # need v26+; verified on 27.0.0
rustup target add wasm32v1-none
curl -L https://raw.githubusercontent.com/noir-lang/noirup/main/install | bash
noirup -v 1.0.0-beta.9              # nargo
curl -L https://raw.githubusercontent.com/AztecProtocol/aztec-packages/refs/heads/next/barretenberg/bbup/install | bash
bbup -v 0.87.0                      # bb
```

Deploy and wire the contracts, then point the frontend at them:

```bash
# 1. Create and fund a deployer identity (friendbot)
stellar keys generate --global deployer --network testnet --fund

# 2. Build, deploy all 4 contracts, wire them, and register the VKs.
#    Set ISSUER_PRIVATE_KEY so the registered issuer key matches the one the
#    app signs with (a 64-char hex secp256k1 key).
ISSUER_PRIVATE_KEY=<hex> SOURCE=deployer ./scripts/deploy.sh

# 3. Configure the frontend
cp frontend/.env.example frontend/.env.local
#    Paste the printed NEXT_PUBLIC_* contract ids, set NEXT_PUBLIC_ISSUER_ADDRESS,
#    and set ISSUER_PRIVATE_KEY (server-only). Persona vars are optional.

# 4. (optional) regenerate circuit artifacts + VKs
./circuits/scripts/build.sh

# 5. Run the app
cd frontend && pnpm install && pnpm dev
```

In the browser: install **Freighter**, switch it to **testnet**, and fund the
account (https://lab.stellar.org or friendbot).

- **Verify** — pick one or more claims; the app issues the credentials to your
  wallet (saved locally, never server-side).
- **Holder** — connect the wallet → "Generate proof" (proves locally, ~seconds)
  → submit to Stellar (signs + submits).
- **Apps** — three demo protocols (LendFi, FundVault, AgeGate) each gated on a
  different claim type; watch *access denied → granted* as `is_verified` flips.

**Rotating the issuer key** doesn't require a redeploy — generate a new key and
call `register_issuer` on the existing IssuerRegistry with the new public key.

> In-browser proving uses cross-origin isolation (COOP/COEP headers in
> `next.config.mjs`) for multithreading, falling back to single-threaded.

---

## Run it end to end (mainnet)

Deploy and wire the contracts on the Stellar Mainnet:

1. **Prepare a funded mainnet identity:**
   Import your funded mainnet deployment account into the Stellar CLI:
   ```bash
   stellar keys import deployer --private-key <your-secret-key>
   ```

2. **Deploy, wire, and register VKs:**
   Run the mainnet deployment script (providing your private issuer key in the environment for registration):
   ```bash
   ISSUER_PRIVATE_KEY=<hex> SOURCE=deployer ./scripts/deploy-mainnet.sh
   ```

3. **Configure the frontend:**
   Copy the printed environment variables to your production environment configuration (e.g., `frontend/.env.local` for local production builds).

---

## Status

- **ZK verification is real**, on soroban-sdk 26 with host-native BN254
  (`soroban_sdk::crypto::bn254`) — on-chain verification fits the resource budget
  (~0.014 XLM/verify on testnet per the reference repo).
- **21 contract tests pass**, including real proof verification for all credential
  types, in-circuit ECDSA, untrusted-issuer and wrong-issuer-key rejections, and
  a proof-expiry test that advances ledger time.
- **Toolchain is pinned**: Noir `1.0.0-beta.9`, Barretenberg `bb 0.87.0`, matching
  the verifier crate; the VK is deterministic from the circuit.
- Server-side issuance, multi-claim flow, the return-URL redirect, the
  `@stellarcred/sdk`, and the Persona relay are wired and build-clean.

---

## References

- ZK on Stellar — https://developers.stellar.org/docs/build/apps/zk
- UltraHonk Soroban verifier — https://github.com/yugocabrio/rs-soroban-ultrahonk
- Noir — https://noir-lang.org/docs
- Stellar Wallets Kit — https://stellarwalletskit.dev

---

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for setup instructions, development workflow, and areas open for contribution.

## License

[MIT](LICENSE) © 2026 Samuel Dahunsi
