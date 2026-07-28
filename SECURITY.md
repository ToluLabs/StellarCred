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
| `contracts/issuer_registry` | Unauthorized issuer registration |
| `app/api/issue/route.ts` | Server-side signing key exposure, credential forgery |
| In-circuit ECDSA (`std::ecdsa_secp256k1`) | Signature bypass |
| Persona KYC relay | Identity data leakage, bypass |

## Security model notes

- `ISSUER_PRIVATE_KEY` must never have a `NEXT_PUBLIC_` prefix — it is server-side only.
- The issuer's secp256k1 signature is verified **inside** the ZK proof (`std::ecdsa_secp256k1`), and the contract checks the public key from public inputs matches the registered issuer key. A valid proof requires a registered issuer to have signed the credential.
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
- [ ] **Key Rotation Procedures:** Test and document the key rotation procedure. Registering a new issuer key in `IssuerRegistry` must be validated, and the corresponding private key updated in the API environment without service disruption.
- [ ] **Revocation:** Ensure compromised issuer keys can be immediately removed or revoked in `IssuerRegistry` by the admin.

### 3. Time-to-Live (TTL) & Ledger Close Times
- [ ] **Ledger Close Alignment:** The verification caching duration (`expiry` / TTL) must be aligned with Stellar mainnet ledger close times (average 5 seconds per ledger).
- [ ] **Storage TTL Verification:** Review the storage TTL (Time-To-Live) settings for contract instances and entries. Confirm they are set high enough to prevent state eviction (by invoking TTL extension on-chain) while optimizing fee costs.
- [ ] **Expiration Checks:** Ensure proof submission expirations account for clock drift and network latency on mainnet.

### 4. Budget & Resource Limits
- [ ] **Gas and Fee Budgets:** Verify that on-chain proof verification costs (CPU instructions and memory usage) fit comfortably within the mainnet limits per transaction and ledger.
- [ ] **Transaction Fees:** Ensure that transactions are submitted with competitive base fees to prevent delays during periods of high mainnet network congestion.
- [ ] **Batch Size Constraints:** If using batch submissions, ensure the batch limits (maximum 5 proofs) prevent transaction execution timeouts and stay well within the Soroban resource limits.
