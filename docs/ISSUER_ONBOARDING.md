# Issuer Onboarding

**Audience:** an organisation (a bank, an employer, a KYC provider, a DAO) that
wants to become a credential issuer in StellarCred.

The holder journey and the protocol-integration path are documented elsewhere.
This guide covers the third role, and the least-documented one: **the issuer is
the trust anchor of the entire system.** Every claim that any protocol ever
accepts reduces to one question — *did a registered issuer sign a commitment to
this?* If your key is compromised, or your signing code drifts from the
circuits, or you stop showing up, the guarantees the whole protocol rests on
quietly stop existing. Read §2 and §3 before generating a key.

---

## Contents

1. [What you are taking on](#1-what-you-are-taking-on)
2. [Generate and safeguard the signing key](#2-generate-and-safeguard-the-signing-key)
3. [What your signature actually attests](#3-what-your-signature-actually-attests)
4. [Register in IssuerRegistry](#4-register-in-issuerregistry)
5. [Issue your first credential](#5-issue-your-first-credential)
6. [Key rotation](#6-key-rotation)
7. [Revocation duties](#7-revocation-duties)
8. [Operational expectations](#8-operational-expectations)
9. [Security requirements](#9-security-requirements)
10. [Troubleshooting](#10-troubleshooting)

---

## 1. What you are taking on

An issuer does three things, and nothing else:

1. **Verifies a person or entity off-chain** — via your own KYC provider,
   payroll system, bank, or registry. This is your legal and reputational
   responsibility and it happens entirely off-chain.
2. **Commits** to the resulting attribute value with a Poseidon2 hash.
3. **Signs** that commitment with a secp256k1 key registered on-chain.

You never handle a proof, a verifying key, or a holder's wallet. Holders prove
the claim; `ProofRegistry` caches the result; protocols read a boolean. Your
entire on-chain surface is three admin-gated entries in `IssuerRegistry` and
one signature format.

The one-line security model, from `circuits/lib/src/lib.nr`:

> A valid proof means "a keypair the contract recognises as a registered issuer
> signed a commitment, and the prover knows the value and salt behind that
> commitment."

Everything below is about protecting that key and making the signature mean
what you intend it to mean.

---

## 2. Generate and safeguard the signing key

### 2.1 Key format

One **secp256k1** keypair, used for all credentials you issue. There is no
per-credential-type key and no per-holder key.

| | |
|---|---|
| Private key | 32 bytes, 64 hex characters, no `0x` prefix |
| Public key on chain | **uncompressed, x‖y — 64 bytes (128 hex chars)**, no `0x04` prefix |
| Environment variable | `ISSUER_PRIVATE_KEY` |

`IssuerClient` rejects anything that is not 64 hex characters, and the
`BytesN<64>` argument to `register_issuer` rejects anything that is not exactly
64 bytes, so a wrong-shaped key fails loudly at the boundary rather than
producing a credential nobody can verify.

### 2.2 Generate it

```bash
# 32 bytes of CSPRNG output, hex-encoded. Run on a machine you trust, once.
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Or from a hardware wallet / KMS that speaks secp256k1, if you have one — see
§2.4. Do **not** generate the key in a browser, in a web UI, or in a repo
script that commits its output.

### 2.3 Derive the public key to register

The repo ships a helper that derives the public key from the same env var, and
it is the canonical way to get the exact 128-hex-char string the contract
wants:

```bash
ISSUER_PRIVATE_KEY=<your 64-hex key> node circuits/scripts/sign.js --pubkey-hex
# → 128 hex characters, x‖y, no 0x04 prefix
```

> **This script falls back to a hard-coded public demo key**
> (`sha256("stellarcred-demo-issuer")`) when `ISSUER_PRIVATE_KEY` is unset, and
> it prints that key without warning. Always export the variable first and
> sanity-check the output against your own key before registering it.

Confirm the value you are about to register matches your signing key, with no
independent tool:

```ts
import { IssuerClient } from "@stellarcred/issuer";
const { x, y } = new IssuerClient({ privateKey: process.env.ISSUER_PRIVATE_KEY! }).publicKey();
console.log(Buffer.from([...x, ...y]).toString("hex")); // must equal the registered value
```

### 2.4 Custody requirements

> **REQUIREMENT — The signing key must be held in a secrets manager or HSM, not
> in a plaintext `.env` file on an application host.** Production-grade custody
> (AWS Secrets Manager, GCP Secret Manager, Vercel encrypted env, Azure Key
> Vault, or a KMS/HSM-backed signer) is the baseline, not an upgrade. A
> plaintext env var on a long-lived server is a single compromise away from
> total forgery: the key signs arbitrary credentials for arbitrary holders.

> **REQUIREMENT — The key must never carry a `NEXT_PUBLIC_` prefix.** Next.js
> inlines any `NEXT_PUBLIC_*` variable into the client bundle at build time.
> `ISSUER_PRIVATE_KEY` must stay unprefixed so it is never shipped. If you fork
> the app, `lib/env.ts` is the boundary that enforces this — do not route the
> key through the client-side config.

> **REQUIREMENT — The key must never appear in a client bundle, a browser
> request body, a log line, an error message, or a repo.** `@stellarcred/issuer`
> is built to make this hard and you must not defeat it:
> - its `package.json` `exports` map only defines a `"node"` condition;
> - the module throws at import time if `typeof window !== "undefined"`;
> - a regression test, `frontend/packages/issuer/src/cross-boundary.test.ts`,
>   locks the issuer↔circuit contract and fails if the client boundary moves.
>
> If you need signing in a browser, you have the wrong architecture: move the
> key server-side.

> **REQUIREMENT — Access to the key must be restricted to the minimum set of
> people and workloads**, and every issuance must be attributable to an
> authenticated operator. The signing endpoint is a trust-anchor operation;
> it is not covered by the demo's public UI.

For reference, the bundled `/api/issue` route ships a deliberately insecure
fallback so the app runs with no configuration: if `ISSUER_PRIVATE_KEY` is
unset it signs with the public demo key and logs a warning. That fallback is
for the demo only. **A production issuer that leaves it in place is signing
every credential with a key published in this repository.**

### 2.5 Separation of duties

The `IssuerRegistry` admin key and your signing key are different keys with
different blast radii, and they must stay separate:

| Key | Purpose | If compromised |
|---|---|---|
| `IssuerRegistry` admin | Registering/revoking issuers, metadata | Attackers can register themselves as issuers and mint anything |
| Your issuer signing key | Signing commitments | Attackers can sign commitments as you; registry contents are untouched |

The admin key should be a multisig (see the admin-key checklist in
[`SECURITY.md`](../SECURITY.md)). Your signing key should be an HSM/KMS
identity. Neither should be able to do the other's job.

---

## 3. What your signature actually attests

This section is the one most issuers get wrong, so it is worth being precise
about what the signature does and does not claim.

### 3.1 The pipeline

```
  attribute (your verified data)
        │
        ▼
  value  ──┐
           ├─► Poseidon2::hash([value, salt], 2) ──► commitment  (public input)
  salt   ──┘                                        │
                                                    │  32 bytes, big-endian
                                                    ▼
                              secp256k1 ECDSA sign (prehash: false)
                                                    │
                            ┌───────────────────────┴──────────┐
                            ▼                                  ▼
                          sig (private)              issuer_x‖issuer_y (public)
```

Then, at proof time, in-circuit (`assert_committed_and_signed`):

```rust
assert(Poseidon2::hash([value, salt], 2) == commitment);
assert(verify_signature(issuer_x, issuer_y, sig, commitment.to_be_bytes()));
```

and on-chain, in `ProofRegistry.submit_proof`:

1. `is_valid_issuer(issuer_id, credential_type)` — you are registered, not
   revoked, and trusted for that exact type;
2. `registry.get_issuer_pubkey(issuer_id)` must equal the `issuer_x‖issuer_y`
   public inputs carried in the proof.

### 3.2 What the signature claims — and what it does not

**It claims exactly this:** *"the holder of secp256k1 private key K signed a
commitment to some value, and whoever presents a proof knows the preimage."*

**It does not, on its own, claim:**

- a credential type;
- a threshold, amount, or date;
- a holder's identity;
- an expiry or issuance timestamp;
- that the attribute was ever independently verified.

None of that is in the signed message. The message is 32 bytes of hash.

Concretely: if you sign a commitment to a date of birth, the signature is
*identical in form* to one signing a net-worth figure. The semantics come from
three things that sit **outside** the signature:

| Layer | Supplies |
|---|---|
| The circuit | the constraint that turns `value` into a claim ("age ≥ 21") |
| `IssuerRegistry` | which issuer is trusted for which `credential_type` |
| Your off-chain process | whether the attribute was true, and whether it is still true |

> **REQUIREMENT — Your signing endpoint is the only place the type, threshold
> and holder are actually bound.** Because they are not in the signed message,
> a signature replayed under a different `credential_type` is a valid
> signature. The single most important control you have is §4.2: register the
> **narrowest** `credential_types` set that reflects what you actually attest
> to, and never sign a commitment without first fixing which claim it is for.

> **REQUIREMENT — You are attesting, not relaying.** A signature over a value
> you did not independently verify is a false attestation under your key, and
> it is indistinguishable on-chain from a genuine one. Never sign a value that
> came from the request body unchecked. Where a provider is authoritative
> (a bank balance, a government ID), **overwrite** any client-supplied value
> with the verified figure — the bundled route does exactly this for Plaid
> balances.

### 3.3 `prehash: false` is load-bearing

> **REQUIREMENT — Sign with `prehash: false`. Never change it.**

`std::ecdsa_secp256k1::verify_signature` consumes a 32-byte *digest*, not a
message. The circuit hands it `commitment.to_be_bytes()` — the raw commitment,
with no hash applied. A signer that pre-hashes would produce a signature over
`sha256(commitment)` instead, and the circuit would reject **every credential
you ever issued**, silently and completely. The flag is not a preference; it is
the other half of that `verify_signature` call.

This is safe precisely because the commitment is already a collision-resistant
Poseidon2 output, not raw attacker-supplied input.

The correct call, as in `frontend/packages/issuer/src/index.ts`:

```ts
const digest = be32(BigInt(commitment));          // big-endian 32 bytes
const sig = secp256k1.sign(digest, privateKey, { prehash: false });
```

The byte encoding matters too: **big-endian**. `cross-boundary.test.ts` exists
to catch a regression in `be32` or the prehash flag, and it fails if either
side drifts.

### 3.4 The salt is not decoration

> **REQUIREMENT — Use a fresh, random, non-zero salt for every credential.**

The commitment is a *public* input, and many of the values you commit to are
low-entropy: a date of birth has tens of thousands of plausible values, an ISO
country code about 250. Without a random salt the commitment is a deterministic
hash and can be reversed by hashing candidates until one matches — reading the
credential straight off the public inputs.

The circuits assert `salt != 0` as defense-in-depth. `@stellarcred/issuer`
generates 31 bytes (248 bits) of `node:crypto` randomness per issuance. Reuse
a salt across two credentials and you have linked them; ship `salt` as a
constant and you have published your attribute.

`employment` is the one 3-arity commitment,
`Poseidon2::hash([status, seniority, salt], 3)`. Seniority must be inside the
preimage, or a holder could self-select any seniority ≥ the threshold and still
satisfy the circuit.

---

## 4. Register in IssuerRegistry

### 4.1 Who can register you

`IssuerRegistry` is admin-only. `register_issuer`, `revoke_issuer` and
`set_issuer_metadata` all call `require_admin()`, and the admin is fixed at
deployment by the contract constructor. **You cannot self-register.** You apply
to the protocol admin, who signs the transaction with the admin key. Plan for
this to be a human, out-of-band step.

### 4.2 Requesting registration

You need three things:

| Argument | Type | What it means |
|---|---|---|
| `issuer_id` | `Address` | A Stellar account you control. Must be able to sign. |
| `pubkey` | `BytesN<64>` | Your secp256k1 x‖y, 128 hex chars (§2.3) |
| `credential_types` | `Vec<Symbol>` | Exactly the claims you will attest to |

```bash
stellar contract invoke \
  --id "$ISSUER_REGISTRY_ID" \
  --source issuer_registry \
  --network testnet \
  --send yes \
  -- register_issuer \
  --issuer_id "G..." \
  --pubkey "1a2b3c...128 hex chars..." \
  --credential_types '["kyc","age"]'
```

> **REQUIREMENT — Register only the credential types you actually attest to.**
> `is_valid_issuer` is the only thing preventing a `kyc` issuer's signature
> from being presented as some other type you happen to also be trusted for,
> because the signature itself carries no type (§3.2). A bank that issues
> `funds` and `accreditation` has no business being registered for `employment`.
> Start narrow; adding a type is a one-line re-registration later.

The type `Symbol` must match, character for character, what a holder passes as
`credential_type` to `ProofRegistry.submit_proof`. The canonical set is:

```
kyc  age  income  jurisdiction  funds  accreditation  employment
```

The contract does **not** validate the string. A typo — `Kyc`, `KYC`,
`income ` — registers you for a type that nothing will ever match, and the
failure surfaces much later as a confusing `IssuerNotTrusted` at proof
submission. Verify after registering (§4.4).

### 4.3 Optional metadata

Once registered, you can attach a display name, URL and logo:

```bash
stellar contract invoke \
  --id "$ISSUER_REGISTRY_ID" --source issuer_registry --network testnet --send yes \
  -- set_issuer_metadata \
  --issuer "G..." \
  --name "Example Bank" \
  --url "https://example.com" \
  --logo "https://example.com/logo.png"
```

Field caps are enforced: name 64 bytes, URL 256, logo 256. Exceeding any of
them panics with `MetadataTooLong` (error 3). Metadata must be set **after**
registration — calling it on an unregistered address panics with
`IssuerNotFound` (error 2). Metadata is public on-chain; never put anything in
it you would not publish.

### 4.4 Verify your registration

```bash
stellar contract invoke --id "$ISSUER_REGISTRY_ID" --source issuer_registry \
  --network testnet --simulate -- get_issuer --issuer "G..."
```

Check three fields:

- `pubkey` — byte-for-byte the value from §2.3;
- `credential_types` — exactly the set you intended, correct casing;
- `revoked` — `false`.

A `pubkey` mismatch here is the single most common cause of total issuance
failure: every proof built from your credentials will be rejected with
`IssuerKeyMismatch` (ProofRegistry error 5) because the contract compares the
proof's public-input key against the registered key.

To enumerate the issuer set, prefer the paginated reads. `get_issuers`
materialises the entire list in one call and will exhaust the instruction
budget on a large set:

```bash
stellar contract invoke --id "$ISSUER_REGISTRY_ID" --source issuer_registry \
  --network testnet --simulate -- issuer_count
stellar contract invoke --id "$ISSUER_REGISTRY_ID" --source issuer_registry \
  --network testnet --simulate -- get_issuers_page --start 0 --limit 20
```

`get_issuers_page` caps `limit` at 20 silently; `pages = ceil(issuer_count / 20)`.

Registration emits an event with topics `("iss_reg", "register")` and payload
`{ issuer, pubkey }` — use it to build monitoring. See
[`docs/EVENTS.md`](EVENTS.md).

---

## 5. Issue your first credential

### 5.1 Using the package

`@stellarcred/issuer` is server-only (see §2.4). It performs the salt
generation, Poseidon2 commitment (executing the same circuit artifact the
proofs use) and prehash-free signing.

```ts
import { IssuerClient } from "@stellarcred/issuer";

const issuer = new IssuerClient({
  privateKey: process.env.ISSUER_PRIVATE_KEY!,  // server-side only
});

const credential = await issuer.issue({
  type: "age",
  holder: "G...",            // holder's address
  issuerId: "G...",          // must match your registered address
  issuerName: "Example Bank",
  expiry: "90 days",         // or an absolute unix timestamp
  attribute: { date_of_birth: "1990-01-01" },
});
```

Each `issue()` call derives an independent value, salt, commitment and
signature. Nothing is reused across calls but the key.

`CREDENTIAL_TYPES` and the per-type `attribute` fields are:

| Type | `attribute` field | Committed `value` |
|---|---|---|
| `kyc` | — | fresh random secret |
| `age` | `date_of_birth` (ISO) | days since Unix epoch |
| `income` | `income` | integer |
| `jurisdiction` | `country_code` (ISO 3166-1 **numeric**) | integer |
| `funds` | `balance` | integer |
| `accreditation` | `net_worth` | integer |
| `employment` | `seniority` | `1`, committed 3-arity with seniority |

`jurisdiction` takes the numeric form (`840`, not `US`); conversion from
alpha-2 belongs at your edge, before the value is committed.

### 5.2 Identity data handling

> **REQUIREMENT — Retain no identity field after the provider call returns.**
> Data returned by a KYC or data provider is used to *derive* the credential
> value and is then discarded. It must not be written to a log, an analytics
> event, an error report, a queue, a cache, a database row, or a request
> context that outlives the call. Only the derived commitment, the signature
> and the public key leave your process.

The bundled route models this: Persona responses are read into local
variables, mapped to a date of birth / numeric country code, and the raw
provider payload is never logged or persisted. The logger also runs every
record through `stripSensitiveFields`. If you add a provider, keep that
property — it is the reason the system can claim it holds no identity data.

Log identifiers you *may* keep: holder address, credential type, issuer id,
outcome, duration, request id. Those are what the structured issuance log
records.

### 5.3 Confirming end to end

The bundled app at `/issuer` issues against a live registry, and `/api/issue`
pre-flight-checks that the server's signing key matches the selected issuer's
registered public key before signing — returning `403` rather than minting a
credential that can never verify. Note the consequence for rotation in §6.

> The demo's issuer dropdown filters to `kyc`, `age`, `jurisdiction`, `income`
> and `funds`. If you register for `accreditation` or `employment` the record
> is on-chain and valid, but it will not appear in that demo UI. Verify those
> types with a direct call or your own front end.

---

## 6. Key rotation

There is no separate rotation entry point: **rotation is re-registration.**
`register_issuer` on your existing address overwrites the stored record with a
new `pubkey` and resets `revoked` to `false`. The enumeration list and count are
unaffected (the address is already present).

```bash
stellar contract invoke --id "$ISSUER_REGISTRY_ID" --source issuer_registry \
  --network testnet --send yes \
  -- register_issuer --issuer "G..." --pubkey "<new x‖y hex>" \
  --credential_types '["kyc","age"]'
```

> **REQUIREMENT — Re-registering must carry the complete intended
> `credential_types` list.** It is a full overwrite, not a merge. Omitting a
> type silently revokes your trust in it; passing a stale list after you have
> narrowed your attestation re-grants it.

### Order of operations for a rotation

This ordering is not cosmetic. `ProofRegistry.revoke(issuer, holder,
credential_type)` is authorized by the issuer address but begins with
`is_valid_issuer`. **If you revoke yourself first, every later holder-level
revocation reverts with `IssuerNotTrusted` (error 4).**

1. Announce a cutover; keep the old key valid for the overlap window so
   in-flight credentials remain provable.
2. Generate the new key in custody (§2.2). **Destroy the old private key
   material only after the overlap closes** — destroying it early invalidates
   every unexpired credential it signed, because those proofs can no longer be
   generated at all.
3. Re-register with the new public key and the full type list.
4. Update `ISSUER_PRIVATE_KEY` in the secrets manager and restart the signer.
5. Verify: `get_issuer` returns the new `pubkey`, and one freshly issued
   credential proves successfully.

> **REQUIREMENT — Rotation must be rehearsed before it is needed.** A
> rotation you have never performed end to end is an outage. Exercise the full
> sequence against testnet and time it.

Because the old key remains registered and valid throughout the overlap,
signatures made under it still verify. Rotation alone does **not** invalidate
previously issued credentials — that is what revocation is for.

---

## 7. Revocation duties

Two different mechanisms, with different reach. Confusing them is the most
common operational error in this system.

### 7.1 Revoking a single holder's credential (you can do this yourself)

```bash
stellar contract invoke --id "$PROOF_REGISTRY_ID" --source proof_registry \
  --network testnet --send yes \
  -- revoke --issuer "G..." --holder "G..." --credential_type "age"
```

Authorized by your issuer address, and it sets the stored proof's `revoked`
flag so `is_verified` returns `false` immediately. The record is retained, not
deleted, so the revocation is auditable.

> **REQUIREMENT — Holder-level revocation must happen before issuer-level
> revocation** (see §6 for why), and before the credential's natural expiry
> runs out.

### 7.2 Revoking the issuer (admin-only)

```bash
stellar contract invoke --id "$ISSUER_REGISTRY_ID" --source issuer_registry \
  --network testnet --send yes -- revoke_issuer --issuer "G..."
```

> **REQUIREMENT — `revoke_issuer` is an admin action, not yours.** You cannot
> revoke yourself in an emergency; the key compromise scenario has to go
> through the protocol admin. Raise it as an incident immediately — do not wait
> for a rotation window.

Emits `("iss_reg", "revoked")` with `{ issuer }`.

### 7.3 What revocation does and does not reach — read this

**`revoke_issuer` does not touch proofs that have already been submitted.** It
sets one flag on your registry record. `ProofRegistry` never re-reads that flag
for stored records. Consequences:

- Credentials you issued **before** revocation, whose proofs were already
  submitted and are still unexpired, **remain valid**.
- New proofs naming you will be rejected at `submit_proof` (`IssuerNotTrusted`).
- Protocols that want issuer-level certainty must pass `trusted_issuers` to
  `is_verified`/`check_claim`; those that pass `None` will keep honouring old
  records. **You cannot fix this on-chain** — it is a property of the calling
  protocol. Raise it with the protocol if it matters to your attestation.

To actually strand outstanding credentials on key compromise, the per-holder
`revoke` (§7.1) is the only tool — and it must be enumerated holder by holder
before you are revoked.

### 7.4 Your standing revocation duties

> **REQUIREMENT — Revoke promptly and without exception when:** your signing
> key or its backup is exposed; you learn a credential was issued on a false
> attestation; an attribute you attested to becomes invalid (employment ends,
> an account is frozen, a licence lapses) and you have not set a short enough
> expiry to cover it; your signing service is compromised; or you are ceasing
> to operate.

> **REQUIREMENT — Set expiries you can stand behind.** Expiry is your main
> self-revocation lever: it is enforced by `ProofRegistry` against ledger time
> with no admin involvement. A 90-day expiry on a credential you would need to
> withdraw in a week is a 90-day window of exposure. Choose per credential type
> according to how fast the underlying fact can change, not uniformly.

---

## 8. Operational expectations

> **REQUIREMENT — You are a standing dependency.** Holders hold credentials
> with no server copy, and `ProofRegistry` caches results with an explicit
> expiry. When your signer is down, holders cannot obtain new credentials, and
> existing ones keep working until they expire — but they cannot be renewed.
> You need a monitored, redundant signing service, not a laptop.

> **REQUIREMENT — Monitor registration state.** `is_valid_issuer` returning
> `true` for the types you expect, and `get_issuer.revoked == false`, are the
> two conditions under which your attestations are worth anything. Alert on the
> `("iss_reg", ...)` event stream and on the absence of successful issuance.
> A silently expired registry record is an outage you will discover from
> holders, not from a dashboard.

> **REQUIREMENT — Refresh your registry record before it ages out.** Issuer
> records are written with a **120-day** state TTL. `register_issuer` and
> `revoke_issuer` bump it; `set_issuer_metadata` bumps only the metadata entry,
> not the issuer record. An issuer that is never touched again can have its
> record expire out of state, after which every proof submission fails with
> `IssuerNotFound` until you re-register. Re-run `register_issuer` with your
> **existing, unchanged** pubkey and type list on a schedule comfortably
> inside 120 days — it is idempotent on list and count, and refreshes the TTL.

> **REQUIREMENT — Run your issuance endpoint with rate limiting, idempotency
> and an audit trail.** Signing is a privileged operation; the bundled route
> models the expected shape — per-IP and per-wallet rate limits, `Idempotency-Key`
> support so a retry cannot double-sign, and structured logs of type, issuer,
> holder, outcome and duration.

> **REQUIREMENT — Keep the signing path byte-compatible with the circuits.**
> The `be32` encoding, the `prehash: false` flag, and the Poseidon2 preimage
> layout are a contract between your signer and the deployed circuits. Changing
> any of them invalidates every credential in flight without any error at
> signing time — the failure only appears when a holder tries to prove.
> `frontend/packages/issuer/src/cross-boundary.test.ts` guards this; run it
> against any signing change before deploying it.

---

## 9. Security requirements

These are obligations, not advice. Each is checkable before you issue.

| # | Requirement | Verify with |
|---|---|---|
| 1 | Signing key held in an HSM or secrets manager, never a plaintext host env | Custody attestation; access review |
| 2 | Key never carries a `NEXT_PUBLIC_` prefix | `grep -r NEXT_PUBLIC_ISSUER frontend/` |
| 3 | Key never present in any client bundle or browser request | `@stellarcred/issuer` node-only exports + `window` guard; `cross-boundary.test.ts` |
| 4 | Key never in git, logs, or error reports | Secret scanning; log review |
| 5 | `prehash: false` preserved, byte-for-byte, with big-endian `be32` | `cross-boundary.test.ts` |
| 6 | No identity field retained after the provider call | `stripSensitiveFields` on every log path; storage review |
| 7 | `credential_types` is the narrowest accurate set | `get_issuer` review |
| 8 | Fresh random non-zero salt per credential | `IssuerClient` (automatic); never override |
| 9 | Admin key and signing key are distinct, admin is a multisig | [`SECURITY.md`](../SECURITY.md) checklist |
| 10 | Rotation rehearsed end to end on testnet, with the §6 ordering | Runbook + test record |
| 11 | Holder-level revocations run before issuer-level revocation | Incident runbook |
| 12 | Registry record refreshed inside the 120-day TTL | Scheduled job + alert |
| 13 | Attributes independently verified before signing; provider values overwrite client-supplied ones | Code review of the signing path |
| 14 | Expiry set per type, matched to how fast the fact changes | Issuance policy |

---

## 10. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `IssuerNotFound` (2) | Not registered, or the record aged out of state | Re-register (§8) |
| `IssuerNotTrusted` (4) at proof submission | Not trusted for that `credential_type`, or revoked | Check `get_issuer.credential_types` and casing |
| `IssuerNotTrusted` (4) from `revoke` | You revoked yourself before revoking holders | Re-register, then revoke holders (§6 ordering) |
| `IssuerKeyMismatch` (5) | Proof's public-input key ≠ registered key | Signing key and registered pubkey diverged; rotate carefully (§6) |
| `MetadataTooLong` (3) | name > 64 B, or url/logo > 256 B | Shorten |
| `NotInitialized` (1) | No admin set at deploy | Redeploy with `--admin` |
| Every proof from this issuer fails | `prehash: true`, or a prehash/SHA-256 step added to signing | Restore `prehash: false` (§3.3) |
| Commitment looks reversible | Salt fixed, zero, or reused | Restore per-credential random salt (§3.4) |
| `403` from `/api/issue` | `ISSUER_PRIVATE_KEY` ≠ registered pubkey | Update the key or the registration (§6) |
| Signature never reaches a holder | Signing succeeded server-side but you never delivered the credential to the holder's device | Delivery is out of scope for this contract; the holder needs commitment, sig, and salt |

---

## Related

- [`docs/THREAT_MODEL.md`](THREAT_MODEL.md) — the attacks each layer defends against
- [`docs/ARCHITECTURE.md`](ARCHITECTURE.md) — how the contracts fit together
- [`docs/EVENTS.md`](EVENTS.md) — the event stream to monitor
- [`docs/contract-error-codes.md`](contract-error-codes.md) — full error reference
- [`SECURITY.md`](../SECURITY.md) — pre-mainnet security checklist
- [`DEPLOYMENTS.md`](../DEPLOYMENTS.md) — contract IDs and network passphrases
- [`frontend/packages/issuer/README.md`](../frontend/packages/issuer/README.md) — the signing package
