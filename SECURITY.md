# Security Policy

## Supported versions

StellarCred is in active development. Security fixes are applied to the latest commit on `main`.

## Reporting a vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Email **dahunsisamuel1st@gmail.com** with:

- A description of the vulnerability and its potential impact
- Steps to reproduce or a proof-of-concept (private gist / attachment is fine)
- Any suggested mitigations if you have them

You will receive an acknowledgement within 48 hours. If the issue is confirmed, a fix will be prioritised and you will be credited in the release notes unless you prefer to remain anonymous.

## Scope

Areas of particular interest:

| Area | Risk |
|------|------|
| `contracts/proof_registry` | Forged proofs accepted on-chain |
| `contracts/issuer_registry` | Unauthorized issuer registration, or abuse of key rotation to keep a superseded key signing |
| `app/api/issue/route.ts` | Server-side signing key exposure, credential forgery |
| In-circuit ECDSA (`std::ecdsa_secp256k1`) | Signature bypass |
| Persona KYC relay | Identity data leakage, bypass |

## Security model notes

- `ISSUER_PRIVATE_KEY` must never have a `NEXT_PUBLIC_` prefix — it is server-side only.
- The issuer's secp256k1 signature is verified **inside** the ZK proof (`std::ecdsa_secp256k1`), and the contract checks the public key from public inputs is one the issuer currently accepts. A valid proof requires a trusted issuer to have signed the credential.
- An issuer may hold several signing keys at once, each with a validity window, so a key rotation does not invalidate outstanding credentials. A key is accepted only if it is inside its window and has not been revoked; an issuer registered before key tracking existed falls back to its single registered key. See [docs/ISSUER_KEY_ROTATION.md](docs/ISSUER_KEY_ROTATION.md).
- `prehash: false` is required when signing — Noir uses the raw 32-byte commitment as the message digest. Changing this breaks all existing proofs.
- Identity fields from KYC providers are used only to derive credential values and are never stored or logged after the API call completes.

See the full threat model and reviewer checklist in [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md).

## Pre-Mainnet Security Checklist

Before deploying StellarCred to the Stellar mainnet, verify that all security parameters and operational keys meet the following production standards:

### 1. Administrative Key Management (Admin Key)
- [ ] **Multi-Signature / HSM Custody:** The administrator key (contract admin) must NOT be a hot wallet stored in plaintext. It must be custody-secured (e.g., using a hardware wallet, an HSM, or a multi-signature account setup with appropriate thresholds).
- [ ] **Minimal Privilege & Revocation:** Ensure the admin key is only used for contract configuration/upgrades and is distinct from operational issuer keys.
- [ ] **Upgrade Authorization:** If the contract is upgradeable, confirm that upgrade authority is assigned to a multisig wallet or a community-controlled DAO address.

### 2. Issuer Cryptographic Keys (Issuer Key)
- [ ] **Secret Key Protection:** The `ISSUER_PRIVATE_KEY` must be securely stored in production-grade environment secrets (e.g., AWS Secrets Manager, GCP Secret Manager, or Vercel Encrypted Environment Variables). It must never be checked into git or exposed to the client-side (do not prefix with `NEXT_PUBLIC_`).
- [ ] **Key Rotation Procedures:** Test and document the key rotation procedure. Use `IssuerRegistry::rotate_issuer_key` with an explicit overlap window (max 90 days) so outstanding credentials stay verifiable, then update the corresponding private key in the API environment without service disruption. Do **not** change an issuer's key via `register_issuer` — it is rejected for issuers with key history precisely to avoid stranding outstanding credentials. The full procedure is in [docs/ISSUER_KEY_ROTATION.md](docs/ISSUER_KEY_ROTATION.md).
- [ ] **Revocation:** Ensure compromised issuer keys can be immediately removed or revoked in `IssuerRegistry` by the admin. Use `IssuerRegistry::revoke_issuer_key`, which takes effect at once rather than waiting out a rotation window. Note that revoking a key does not retroactively clear `ProofRecord`s already cached by `ProofRegistry`; those expire on their own `expiry` or need an explicit `revoke_proof`.
- [ ] **Overlapping-key Risk:** Choose the shortest rotation overlap window your re-issuance process tolerates. During the window a superseded key can still mint new credentials, so a long overlap is a live risk, not just a convenience.

### 3. Time-to-Live (TTL) & Ledger Close Times
- [ ] **Ledger Close Alignment:** The verification caching duration (`expiry` / TTL) must be aligned with Stellar mainnet ledger close times (average 5 seconds per ledger).
- [ ] **Storage TTL Verification:** Review the storage TTL (Time-To-Live) settings for contract instances and entries. Confirm they are set high enough to prevent state eviction (by invoking TTL extension on-chain) while optimizing fee costs.
- [ ] **Expiration Checks:** Ensure proof submission expirations account for clock drift and network latency on mainnet.

### 4. Budget & Resource Limits
- [ ] **Gas and Fee Budgets:** Verify that on-chain proof verification costs (CPU instructions and memory usage) fit comfortably within the mainnet limits per transaction and ledger.
- [ ] **Transaction Fees:** Ensure that transactions are submitted with competitive base fees to prevent delays during periods of high mainnet network congestion.
- [ ] **Batch Size Constraints:** If using batch submissions, ensure the batch limits (maximum 5 proofs) prevent transaction execution timeouts and stay well within the Soroban resource limits.
