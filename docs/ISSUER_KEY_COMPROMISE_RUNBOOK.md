# Issuer Signing Key Compromise: Threat Analysis and Incident Runbook

What to do when an issuer's secp256k1 signing key (the "master" key that signs
credential commitments) may be in someone else's hands. This document covers the
incident end to end: what an attacker can do with the key, how to contain it,
how to find and revoke forged proofs, who to notify, and how to re-issue
credentials to legitimate holders.

The on-chain mechanics of `revoke_issuer_key` and `rotate_issuer_key` are
documented in [ISSUER_KEY_ROTATION.md](ISSUER_KEY_ROTATION.md); this runbook
links to it rather than repeating it. The contract admin key (the Stellar
account that holds the `admin` role) is a different key with different custody;
if it is also in doubt, treat that as a separate, higher-severity incident.

---

## 1. Threat analysis

### What the attacker can do with the signing key

The key signs `Poseidon2(secret, salt)` commitments. Every proof circuit checks
that signature in-circuit and exposes the signer's public key as a public input,
and `ProofRegistry` accepts the proof if that key is in the issuer's live key
set (`IssuerRegistry.is_valid_issuer_key`). With the private key, an attacker can:

- **Mint credentials offline** for any value and any credential type the issuer
  is trusted for, and prove them from any Stellar account they control. Nothing
  on-chain or in the issuance service is involved, so nothing is logged.
- **Keep doing it until the key is revoked on-chain.** Disabling the key in the
  KMS/Vault, or removing `ISSUER_PRIVATE_KEY`, does not stop proofs signed with
  an already-exfiltrated copy. Only `revoke_issuer_key` does.

The attacker **cannot**, with the signing key alone: change the registry (that
needs the admin role), or revoke other holders' proofs (`ProofRegistry.revoke`
needs the issuer's *Stellar account* signature, not the secp256k1 key).

### What revocation does and does not undo

| | Effect of `revoke_issuer_key` |
|---|---|
| New submissions (`submit_proof`, `submit_proofs`, `submit_aggregate_proof`) signed with the key | Rejected from the next ledger (`IssuerKeyMismatch`, or `IssuerNotTrusted` when it was the current key). |
| New issuance by the issuer, if the revoked key was the current one | Blocked: `is_valid_issuer` returns `false` until a rotation installs a new key. |
| **Proofs already submitted and cached in `ProofRegistry`** | **Not affected.** `is_verified` and `check_claim` read the cached `ProofRecord` and check only its revoked flag, expiry and issuer address. They do not re-check the signing key, and the record does not store it. |

The last row is the dangerous one. Every forged proof submitted between the
compromise and the revocation keeps answering `true` to integrating protocols
until its expiry (up to 365 days) unless it is revoked explicitly (§4, Phase 4).

### Exposure window

```
T0 = earliest time the key could have been copied (be conservative)
T1 = ledger timestamp of the revoke_issuer_key transaction
```

Every `proof_reg.submitted` event for this issuer between T0 and T1 is in scope.
When T0 is unknown, use the time the key was created or last rotated in.

---

## 2. Detection and triage

Treat any of these as a suspected compromise and start §4 Phase 1 immediately.
Do not wait for proof of misuse.

- The private key appears somewhere it should not: a commit, a log line, a
  build artefact, a ticket, a screenshot, a laptop that left custody.
- KMS/Vault audit logs show a read or export you cannot attribute.
- `proof_reg.submitted` events for the issuer whose commitments are **not** in
  the issuance audit log (see [audit-log.md](audit-log.md)). Every legitimate
  credential the service signs adds a log entry, so a submitted commitment with
  no entry was signed elsewhere.
- An `iss_reg.key_rot` or `iss_reg.key_revk` event nobody scheduled (see
  [ISSUER_KEY_ROTATION.md §8](ISSUER_KEY_ROTATION.md#8-events-to-alert-on)).
- A credible external report.

Severity: if the admin key or the issuer's Stellar account key may also be
exposed, escalate. An attacker with the admin key can rotate the issuer to a key
they own, and one with the issuer account can revoke legitimate holders' proofs.

---

## 3. Roles

| Role | Holds | Needed for |
|---|---|---|
| Incident lead | Decision authority | Declaring the incident, choosing T0, approving notifications |
| Registry admin | `admin` role on `IssuerRegistry` (multisig/HSM per [SECURITY.md](../SECURITY.md)) | `revoke_issuer_key`, `rotate_issuer_key` |
| Issuer operator | The issuer's Stellar account and the issuance service | Swapping the signing key, `ProofRegistry.revoke`, batch re-issuance |
| Pauser (optional) | `pauser` role on `ProofRegistry` | `pause` / `unpause` (§4, Phase 1) |

Know the admin multisig quorum and on-call path before an incident: revocation
takes as long as that approval does.

---

## 4. Response procedure

### Phase 1: Contain (target: minutes)

1. **Revoke the key on-chain.** This is the only step that stops new forged
   proofs. Run [ISSUER_KEY_ROTATION.md §5 Step 1](ISSUER_KEY_ROTATION.md#5-procedure-b--emergency-revocation-compromise):

   ```bash
   stellar contract invoke --id "$ISSUER_REGISTRY_ID" --source "$ADMIN_KEY" \
     --rpc-url "$RPC_URL" --network-passphrase "$NETWORK_PASSPHRASE" --send yes \
     -- revoke_issuer_key --issuer_id "$ISSUER_ADDRESS" --pubkey "$COMPROMISED_PUBKEY_HEX"
   ```

   Record the transaction hash and its ledger timestamp: that is T1.
2. **Stop issuance.** Take `POST /api/issue` and `POST /api/issue/batch` offline
   for this issuer. Both sign with the configured key, and a revoked current key
   makes every credential they issue unprovable anyway.
3. **Disable the key material.** Disable or destroy the key in the KMS/Vault and
   remove it from every environment that held `ISSUER_PRIVATE_KEY`.
4. **Pause submissions only if needed.** `ProofRegistry.pause` (pauser role)
   blocks every submission for *every* issuer with `SubmissionsPaused`; reads
   keep working. Step 1 already blocks the compromised key, so pause only if the
   admin key is also in doubt or Step 1 cannot be executed quickly.

### Phase 2: Restore a clean signing key

1. Generate a new key pair inside the KMS/HSM and export only the public key
   (`x ‖ y`, 64 bytes).
2. Rotate it in with [ISSUER_KEY_ROTATION.md §4](ISSUER_KEY_ROTATION.md#4-procedure-a--rotation-the-normal-path).
   Because the current key was revoked, the rotation records it as revoked
   (never valid again) and clears the issuer's blocked state. Any
   `old_key_valid_until` the contract accepts will do; the revoked key does not
   regain validity.
3. Point the issuance service at the new key: update the Vault secret, or
   `ISSUER_PRIVATE_KEY` and restart the service (the default issuer client is
   built from the environment when the module loads).
4. Verify with `get_issuer_pubkey` that the registry's current key is the new
   one. `POST /api/issue/batch` also checks this per request: when
   `NEXT_PUBLIC_ISSUER_REGISTRY_ID` is set, it rejects items while the
   registered key differs from the service's signing key.

Phase 2 must come before Phase 4. `ProofRegistry.revoke` requires the issuer to
pass `is_valid_issuer`, which stays `false` while the current key is revoked.

### Phase 3: Find the affected proofs

`ProofRecord` stores neither the signing key nor the commitment, so the proof
transactions themselves are the record. For each `proof_reg.submitted` event
whose `issuer` is this issuer and whose ledger falls in `[T0, T1]`:

1. Fetch the submitting transaction (Stellar RPC `getEvents` returns the
   transaction hash; `getTransaction` returns the envelope) and decode the
   `public_inputs` argument of the `submit_proof`, `submit_proofs` or
   `submit_aggregate_proof` call. RPC providers keep events for a limited
   window; for older ledgers use an archival source or the ledgers recorded by
   your indexer ([services/indexer](../services/indexer/README.md)).
2. Read the fields (32 bytes each):

   | Submission | Commitment | Signing key (`x ‖ y`, one byte in the last byte of each field) |
   |---|---|---|
   | `submit_proof` / `submit_proofs` (every single-credential circuit) | field 0 | fields 1 to 64 |
   | `submit_aggregate_proof`, KYC part | field 0 | fields 1 to 64 |
   | `submit_aggregate_proof`, age part | field 65 | fields 66 to 129 |

3. Classify each record:

   | Signing key | Commitment in the issuance audit log | Verdict |
   |---|---|---|
   | compromised key | no | **Forged.** Revoke in Phase 4. |
   | compromised key | yes | Legitimate holder; the proof is genuine. See Phase 4. |
   | any other key | n/a | Not affected. |

   Run `pnpm verify:audit-log` (from `frontend/`) first and only trust the log
   if the chain is intact. Compare commitments as integers: the log stores the
   commitment as a decimal or `0x` string, the public input holds the same value
   as 32 big-endian bytes. The audit log is single-instance per deployment
   ([audit-log.md](audit-log.md#implementation-notes)); merge the logs of every
   instance that issued during the window.

### Phase 4: Revoke forged proofs

The issuer operator revokes each forged record, signing with the issuer's
Stellar account:

```bash
stellar contract invoke --id "$PROOF_REGISTRY_ID" --source "$ISSUER_ACCOUNT_KEY" \
  --rpc-url "$RPC_URL" --network-passphrase "$NETWORK_PASSPHRASE" --send yes \
  -- revoke --issuer "$ISSUER_ADDRESS" --holder "$HOLDER" \
  --credential_type "$CREDENTIAL_TYPE" --reason 2
```

`--reason` is a `RevocationReason` code: `2` is `Fraud`, `1` is `Superseded`.
`revoke` only works on records whose stored issuer is this issuer, sets the
record's `revoked` flag, and emits `proof_reg.revoked` with the reason, which
integrating protocols and the indexer pick up. Afterwards `is_verified` returns
`false` for that holder and credential type.

Legitimate records signed with the compromised key keep verifying until their
expiry; the holder really did pass verification. Revoke them as well (reason
`Superseded`, `--reason 1`) and re-issue in Phase 6 if any of these hold: T0 is uncertain,
the audit log is incomplete or failed verification, or your policy says a proof
signed by a compromised key is not trusted regardless of origin.

### Phase 5: Notify

| Audience | What they see on-chain | What to send them |
|---|---|---|
| Integrating protocols and verifiers | `iss_reg.key_revk`, `iss_reg.key_rot`, and one `proof_reg.revoked` (reason `Fraud`) per forged record | The issuer address, the revoked public key, the window `[T0, T1]`, the number of revoked records, and a reminder to re-check `is_verified` / `check_claim` rather than trust any cached result from that window. |
| Holders of credentials signed by the revoked key | The holder page shows the "Issuer key revoked" badge ([ISSUER_LIFECYCLE.md §3](ISSUER_LIFECYCLE.md#3-what-the-holder-ui-surfaces)) | The emergency notice in [ISSUER_KEY_ROTATION.md §7](ISSUER_KEY_ROTATION.md#7-communicating-with-holders), plus how to request a re-issued credential. |
| Holders whose proofs were revoked as `Superseded` | `proof_reg.revoked` for their address | That their proof was revoked as a precaution, not for anything they did, and how to re-prove. |
| Internal / auditors | All of the above | Timeline, T0 reasoning, commands run with transaction hashes, record counts per verdict. |

Send protocol notices as soon as Phase 1 is done, before the scoping work
finishes: they can tighten their own checks while you work.

### Phase 6: Re-issue in batches

Holders whose credential was signed by the revoked key can no longer submit new
proofs with it (`IssuerKeyMismatch`), so they need a credential signed by the
new key.

- Use `POST /api/issue/batch` with the tenant API key, one item per holder
  (`holder` plus `credential_types` or `type`). A request carries at most **50
  items**; split larger holder lists into several requests.
- Send an `Idempotency-Key` header per request so a retried batch does not sign
  twice. This needs the encrypted replay store configured; without it the route
  answers `503` for keyed requests.
- Requests are rate-limited per IP (`LIMITS.issuePerIp`); pace the batches and
  honour `429 Retry-After`.
- Check the response: items fail individually (`success: false` with an
  `error`), so retry only the failed indexes.
- Each signed credential adds an audit-log entry, so the re-issued set is
  auditable like any other issuance.
- Re-issue only to holders identified as legitimate in Phase 3 or by the
  issuer's own customer records. Never re-issue to an address because a forged
  proof was submitted from it.

Holders then submit a fresh proof with the new credential.

### Phase 7: Close out

- Confirm with `get_issuer_keys` that the compromised key is marked revoked and
  the new key is current, and with `is_verified` that every forged record now
  reads `false`.
- Unpause `ProofRegistry` if Phase 1 paused it.
- Write the incident record: T0, T1, records found per verdict, revocation
  transaction hashes, notifications sent.
- Fix the root cause (how the key left custody) before the next rotation, and
  update [THREAT_MODEL.md](THREAT_MODEL.md) if the incident exposed a gap.

---

## 5. Checklist

| # | Step | Owner | Done when |
|---|---|---|---|
| 1 | `revoke_issuer_key` on the compromised key | Registry admin | Transaction confirmed; T1 recorded |
| 2 | Issuance endpoints stopped for this issuer | Issuer operator | No new credentials signed with the old key |
| 3 | Key disabled in KMS/Vault and environments | Issuer operator | No environment can load it |
| 4 | New key generated and rotated in | Registry admin | `get_issuer_pubkey` returns the new key |
| 5 | Issuance service on the new key | Issuer operator | Batch issuance passes its registry key check |
| 6 | Submissions in `[T0, T1]` classified | Issuer operator | Every record is forged, legitimate or unaffected |
| 7 | Forged records revoked (`Fraud`) | Issuer operator | `is_verified` returns `false` for each |
| 8 | Protocols, holders and auditors notified | Incident lead | Notices sent (§4, Phase 5) |
| 9 | Legitimate holders re-issued | Issuer operator | Batch responses show no failed items |
| 10 | Incident record written, root cause fixed | Incident lead | Record filed |

---

## 6. Rehearsal

Run the procedure on testnet before you need it: register an issuer, submit a
proof, "leak" the key by signing a second credential outside the issuance
service and submitting it, then run Phases 1 to 4 and confirm the forged proof
reads `false` while the legitimate one still reads `true`. The contract tests
for the underlying calls are in `contracts/issuer_registry/src/test.rs` and
`contracts/proof_registry/src/test.rs`.
