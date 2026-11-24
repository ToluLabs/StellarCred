# Limitations and Non-Goals

StellarCred's privacy guarantee is scoped to the **contents** of a credential. The raw
attribute value and its random salt never leave the holder's device, and only the proof and
its public inputs are written on-chain. That guarantee does not — and is not designed to —
hide the *fact* of a verification, the wallet it belongs to, or the parties that necessarily
see an attribute during issuance.

Those boundaries are currently spread across the [README](../README.md),
[ARCHITECTURE.md](ARCHITECTURE.md), [THREAT_MODEL.md](THREAT_MODEL.md),
[SECURITY.md](../SECURITY.md), and the [ADRs](adr/README.md). This document consolidates
them in one place so that a user or integrator can see, before relying on the system, what it
does not hide, does not recover, and does not guarantee — broken down by which party observes
what.

None of these are flaws. They are consequences of publishing reusable proofs on a public
ledger, and stating them plainly is intentional (see
[ADR-004: Public-by-default verification reads](adr/ADR-004-public-read-default.md)).

## At a glance

| Property | Guaranteed? | Notes |
| --- | --- | --- |
| Credential value and salt stay off-chain and off-server | Yes | Only the holder's device holds them. |
| Issuer signature binds a credential to a registered issuer | Yes | Verified in-circuit and on-chain. |
| Proof contents prove only the claim, not the raw attribute | Yes | Threshold/binary result plus public inputs. |
| Which wallet holds which claim type is hidden | No | Public on-chain state. |
| Submitting a proof is unlinkable to the wallet over time | No | The submission permanently links them in ledger history. |
| The issuer is blind to the attribute at issuance | No | The issuer derives and signs the commitment and must know the value. |
| Delegation grants are confidential | No | Grants are on-chain and publicly observable ([#554](https://github.com/ToluLabs/StellarCred/issues/554)). |
| Credentials can be recovered without a backup | No | They live only in one browser's `localStorage`. |
| Verification status is private from protocols | No | `is_verified` / `check_claim` are public reads by design. |

## What is not hidden

### 1. On-chain claims are publicly readable

Submitting a proof writes a `ProofRecord` to `ProofRegistry` persistent storage, and both the
record and the contract events are part of ordinary public ledger state. Anyone with RPC or
indexer access can see **which wallet holds which credential type**, the issuer id, the
threshold (for parameterised types), `verified_at`, and the expiry — without any holder
permission and without a valid delegation. This is deliberate: reads are public and
unauthenticated so any protocol can compose permissionlessly (ADR-004). The raw commitment,
salt, signature, and attribute value are never part of that state.

### 2. Submission permanently links a wallet to the claim

The moment a holder calls `submit_proof`, the wallet address is bound to that credential type
in the ledger. That link persists in transaction history and in emitted events even after the
record's own expiry, and even if the holder later calls `revoke_proof`: revocation removes the
*current* record (making `is_verified` false for everyone), but it cannot unwrite the history
of the submission. A holder cannot retroactively make a past verification invisible to a
specific observer — the only choice is whether to submit at all
([ADR-003](adr/ADR-003-holder-authorized-submission.md)).

### 3. Delegation grants may be publicly observable

`grant_verification` writes a `Delegation(holder, verifier, credential_type)` entry and emits
grant/revocation events. Both are public ledger data, enumerable by any indexer or RPC client,
and `check_delegated_verification` performs no `require_auth` on its caller. The genuinely new
disclosure is the *relationship* — that a specific holder named a specific verifier — not the
claim's contents. This is a known and accepted trade-off of the design rather than something
the contract layer can hide; see the "Delegated Verification" section of
[THREAT_MODEL.md](THREAT_MODEL.md) and issue
[#554](https://github.com/ToluLabs/StellarCred/issues/554).

### 4. The issuer sees the attribute at issuance

Privacy here is from the **verifier**, not from the **issuer**. To create a credential the
issuer must compute `commitment = Poseidon2([value, salt])` and sign it, so the issuance path
necessarily handles the attribute value and the salt; for KYC types the KYC provider (Persona)
also sees the underlying identity fields. The on-chain world never sees them, but the issuing
party does. Treat the issuer (and its KYC provider) as trusted to know the attribute it
attests to, and to keep it confidential after issuance.

### 5. Transaction and network metadata

A submission is an ordinary Stellar transaction. Its source account, timing, fee, and ledger
inclusion are visible to network observers. Submitting from a wallet therefore correlates the
holder's on-chain activity with their verification, independent of what the proof reveals.

## What is not recoverable

### 1. Credentials live in one browser and are lost without a backup

Credentials — including the raw value and the random salt — are stored **only** in the
browser's `localStorage` under `stellarcred:credentials`. There is no StellarCred account and
no server-side credential database, so nothing can be restored from a server:

- Clearing site data, switching browsers or devices, or browsing privately erases them.
- There is no server copy to recover them from, and no support process that can restore them.
- Recovery is entirely user-driven: **Export backup** on the Holder page, **Guardian
  recovery** (Shamir Secret Sharing, threshold-held key shares), or a one-credential
  **Transfer to another device** QR flow. Each must be set up *before* the credential is lost.

If none of those was used, a lost credential is gone permanently and the holder must obtain a
new one from the issuer.

### 2. A submitted proof cannot be removed from history

As above, `revoke_proof` deletes the current record and flips `is_verified` to false, but it
does not erase the transaction, the emitted events, or any indexer's historical copy. Past
disclosure is not reversible.

### 3. Re-issuance does not restore the original claim

Getting a fresh credential from the issuer produces a new commitment and signature. It does
not recover the old credential's value, and it does not remove the earlier wallet-to-claim
link from the ledger.

## What is not guaranteed

### 1. Hiding the fact of verification — only its contents

StellarCred hides *what* the credential says, not *that* a wallet verified. Anyone reading the
chain learns the wallet, the credential type, the issuer, and the expiry. Do not treat
submission as a private or off-the-record action.

### 2. Threshold semantics leak a bound

`check_claim(holder, type, min_threshold)` proves the attribute is at least the queried
threshold. The exact value is hidden, but the query itself reveals the bound being enforced,
and a proof satisfying a high threshold also satisfies every lower one. Choose thresholds
deliberately; they are visible in the read and, for some types, in the record.

### 3. No cross-protocol unlinkability

All protocols share one `ProofRegistry`. The same wallet and credential type are visible
across every integration that reads it, so behaviour can be correlated across protocols by any
chain observer or indexer. The system is composable by design, not unlinkable by design.

### 4. Issuer and provider honesty

A valid proof only establishes that a **registered** issuer signed a commitment, not that the
attested fact is true. Correctness of the value depends on the issuer's process and, for KYC
types, on the KYC provider. A compromised issuer key can mint apparently valid credentials
until it is revoked.

### 5. Freshness and availability

A verified result is a cached boolean valid until its expiry. The contract cannot detect an
issuer-side change or key compromise on its own — a compromised verifier key remains usable
for the life of a live grant, and only the holder can revoke. Proof generation also requires a
compatible browser and the circuit assets; availability is not guaranteed.

### 6. Device and browser trust

Local proving assumes the device is not already compromised. A fully compromised browser or
device can exfiltrate the raw attribute before the proof is generated, which the ZK layer
cannot prevent.

## Who learns what

| Party | Learns | Does not learn |
| --- | --- | --- |
| **Issuer** (and its KYC provider) | The attribute value, salt, and holder identity fields at issuance; that a credential was requested and to which wallet it was issued. As a chain reader, it can also correlate that wallet's later public submissions. | No secret beyond what issuance already required. The later holder-to-verifier link is public ledger data, not something disclosed uniquely to the issuer. |
| **Verifier** (relying protocol) | The `is_verified` / `check_claim` result, credential type, issuer id, threshold queried, `verified_at`, and expiry. | The raw attribute value, salt, signature, or commitment preimage. |
| **Chain observer** (anyone with RPC or ledger access) | Wallet-to-claim-type links, issuer ids, thresholds, expiries, delegation grants and their lifecycle events, and transaction metadata. | The raw attribute value, salt, signature, identity fields, or any off-chain credential data. |
| **Indexer operator** (the `services/indexer` service and anyone running it) | Everything a chain observer sees, plus a persisted, queryable history per wallet — claim lifecycle, revocations, and `threshold`/`issuer` metadata — republished through its public read API. It stores no identity fields. | The raw attribute value or salt; neither is ever on-chain to index. |
| **Holder's device / browser** | The raw value and salt — the only place they exist. | — (this is the trusted endpoint of the system). |

## Non-goals

- **Not a KYC or identity provider.** StellarCred relays to issuers and KYC providers; it does
  not verify identity or hold identity documents.
- **Not an anonymity system.** It does not hide the transaction graph, the wallet-to-claim
  link, or the holder-verifier relationship established by a delegation.
- **Not a recoverable credential wallet.** There is no account, no server-side vault, and no
  recovery path other than a backup the holder made in advance.
- **Not a confidential delegation channel.** On-chain grants are public by construction; hiding
  that a relationship exists requires off-chain infrastructure this design does not implement
  ([#554](https://github.com/ToluLabs/StellarCred/issues/554)).
- **Not a trusted-issuer oracle.** A proof binds a credential to a registered issuer; it does
  not establish that the issuer's assertion is correct.
- **Not a threshold-hiding system.** The queried bound and the satisfied bound are visible.

## Related documentation

- [README — Security model](../README.md#security-model) and
  [README — Where your credentials live](../README.md#where-your-credentials-live)
- [Architecture — Trust Boundaries](ARCHITECTURE.md#trust-boundaries)
- [Threat Model](THREAT_MODEL.md), including the Delegated Verification section
- [ADR-003: Holder-authorized submission](adr/ADR-003-holder-authorized-submission.md)
- [ADR-004: Public-by-default verification reads](adr/ADR-004-public-read-default.md)
- [Issuer onboarding guide](ISSUER_ONBOARDING.md) and
  [Issuer key rotation](ISSUER_KEY_ROTATION.md)
