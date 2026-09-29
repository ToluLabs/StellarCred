# Issuer Key Management Runbook

Operational procedure for moving an issuer to a new secp256k1 signing key
without invalidating the credentials it has already issued, and for killing a
key immediately when it is compromised.

Applies to `IssuerRegistry` (version 1.1.0 and later). ProofRegistry
(`submit_proof`, `submit_proofs`, `submit_aggregate_proof`) is the consumer that
benefits; it verifies proofs against the issuer's **key set** rather than a
single registered key.

This runbook covers the two paths an operator can take — **planned rotation**
and **emergency revocation** — and answers, for each: what happens to
credentials already issued, whether holders must do anything, how long the old
key keeps working, and how to tell holders. It assumes keys live in a
KMS/HSM or secrets manager per [#69](https://github.com/ToluLabs/StellarCred/issues/69);
see §3 for how that custody shapes the steps.

Key-management entrypoints on `IssuerRegistry` (all admin-role only):
`rotate_issuer_key`, `revoke_issuer_key`, `is_valid_issuer_key`,
`get_issuer_keys`, `refresh_issuer_keys_ttl`.

---

## 1. Why this exists

A credential is bound to the secp256k1 key that signed it: the circuit verifies
the issuer signature over the commitment, and the key travels with the proof as
a public input. While `IssuerRegistry` held exactly one key per issuer, any key
change silently invalidated every credential already in a holder's wallet —
submissions failed with `IssuerKeyMismatch` and there was no migration path.

An issuer now holds a **key set**:

| | Current key | Retired key |
|---|---|---|
| Backs new issuance | yes | no |
| Backs already-issued credentials | yes | yes, until its validity window closes |
| Can be revoked | yes (issuance stops) | yes (verification stops) |
| Validity window | none (open-ended) | `(retired_at, valid_until]` |

---

## 2. Choosing a path: rotate or revoke

Do this first, under pressure or not. The two operations are not
interchangeable: **rotation preserves outstanding credentials, revocation kills
them.**

**Rotate when you still control the key.** Planned hygiene, a KMS/HSM
migration, a personnel change where the private key never left custody, or
simply standard key age-out — the key is not believed to be in anyone else's
hands. Rotation installs a new signing key and lets old credentials reach their
natural expiry.

**Revoke when the key may have leaked and you cannot rule it out.** A private
key committed to a repo, written to a log, readable by someone who should not
have it, sitting in a KMS whose access boundary you can no longer trust, or the
subject of a credible compromise report. Revocation is immediate and ignores
the validity window. If the compromised key is the *current* signing key,
revocation also stops the issuer from issuing until a rotation installs a
replacement — do **revoke, then rotate** (`§5` then `§4`).

**Decision flow**

1. Is the key still under your sole control, with no evidence or credible
   suspicion of misuse? → **Rotate** (§4).
2. Is compromise suspected or confirmed, or is custody unclear? → **Revoke**
   (§5).
3. Was the key you just revoked the issuer's *current* signing key? → also
   **Rotate** (§4) so issuance can resume.
4. Was it a *retired* key still inside its window? → revocation alone is the
   whole fix; the current key keeps issuing.

**What each path does to outstanding credentials and holders**

| Path | Credentials already issued | Old key keeps verifying | Holder action |
|---|---|---|---|
| **Rotate** (§4) | Keep verifying until their natural expiry | Yes, through `old_key_valid_until` (up to 366 days) | **None.** Holders keep presenting existing credentials; no re-proof, no wallet change. |
| **Revoke a retired key** (§5) | Those signed by the revoked key stop verifying on the next ledger; all others are unaffected | No — immediate, window ignored | **Only holders whose credential was signed by the revoked key** must re-prove with a credential signed by a live key. |
| **Revoke the current key** (§5), then rotate | Those signed by the revoked key stop verifying immediately; those signed by other, non-revoked retired keys keep verifying until their own windows close | No — immediate | Holders of revoked-key credentials must re-prove; issuance is paused until the follow-up rotation. |

Rotation is the default. Revocation is the emergency path and is deliberately
unforgiving: it ignores the validity window.

---

## 3. Where the keys live (KMS/HSM — #69)

Two *different* key pairs are involved, and they have different custody
requirements. Keep them separate.

| Key | What it does | Where the private half lives |
|---|---|---|
| **Issuer signing key** (secp256k1) | Signs credential commitments during issuance; the pubkey is bound into every proof | The issuance environment — a KMS/HSM or secrets manager, per [#69](https://github.com/ToluLabs/StellarCred/issues/69). The private key must never reach a build artefact, a test fixture, a log, or the browser. |
| **Contract admin key** (Stellar account) | Authorizes `rotate_issuer_key` / `revoke_issuer_key` (and all other admin-role calls) | Custody-secured per the pre-mainnet checklist in [SECURITY.md](../SECURITY.md): hardware wallet, HSM, or multisig — never a plaintext hot wallet. |

How the KMS/HSM shapes the procedure:

- **On-chain state is public keys only.** `IssuerRegistry` stores the issuer's
  public keys and never sees private material, so the steps below are the same
  regardless of which KMS/HSM you use — #69 defines *where* the signing key is
  held, not a different on-chain flow.
- **Generate the new key inside the KMS/HSM** and export only its public key.
  The `new_pubkey` argument to `rotate_issuer_key` is `x ‖ y`, 64 bytes.
- **The old private key is not needed to keep old credentials verifying.**
  Verification is a public-key check on-chain; only the retired *public* key
  matters for the window. Once issuance has cut over, you can disable the old
  private key in the KMS/HSM immediately — nothing off-chain needs it. If the
  old private half may have leaked, destroy it in the KMS/HSM *and* revoke the
  retired public key (§5) so neither side keeps working.
- **Window length is your leak-exposure budget.** A retired key that is still
  inside its window will accept forged credentials signed with its private
  half, so if the old key *might* have escaped, revoke it (§5) rather than
  riding out a long window.
- **The admin key may add latency.** If the admin authority is a multisig or an
  HSM that needs human approval, an emergency revocation takes as long as that
  approval. Know the quorum and the on-call path *before* an incident, and
  pre-stage the replacement key so §4 can follow §5 without delay.

---

## 4. Procedure A — rotation (the normal path)

**Preconditions**

- The new key pair is generated in the issuer's signing environment (KMS/HSM or
  equivalent — see §3). The private key must never touch a build artefact or a
  browser.
- You hold the `admin` role on `IssuerRegistry`. Key management is admin-only,
  like issuer registration itself; an issuer cannot rewrite the registry's view
  of its own key. (Delegating that role is root-admin-only, via `grant_role`.)
- You know the latest expiry among the issuer's outstanding credentials. That is
  the value the window must cover.

**Impact on outstanding credentials:** none. Credentials signed by the old key
keep verifying until `old_key_valid_until`; new issuance uses the new key.
**Holders do not need to act** — they present the same credentials as before.

**Step 1 — pick the window**

```
old_key_valid_until = max(expiry of every outstanding credential of this issuer)
```

Constraints enforced on-chain:

- `old_key_valid_until` must be **strictly greater** than the current ledger
  timestamp, and at most **366 days** ahead (`MAX_KEY_RETENTION_SECS`). This
  matches `ProofRegistry`'s one-year maximum credential TTL, so any credential
  the protocol is willing to accept can always be covered by one window.
- Too short and holders' credentials break before they expire
  (`IssuerKeyMismatch`). Too long and a leaked retired key keeps working for
  longer than necessary. This value is the only knob controlling how long the
  old key stays valid.

**Step 2 — rotate**

```bash
stellar contract invoke \
  --id "$ISSUER_REGISTRY_ID" \
  --source "$ADMIN_KEY" \
  --rpc-url "$RPC_URL" \
  --network-passphrase "$NETWORK_PASSPHRASE" \
  --send yes \
  -- rotate_issuer_key \
  --issuer_id "$ISSUER_ADDRESS" \
  --new_pubkey "$NEW_PUBKEY_HEX" \
  --old_key_valid_until "$OLD_KEY_VALID_UNTIL"
```

The previous key is retired with the window above and `new_pubkey` becomes the
key used for all new issuance. The issuer's credential-type trust is unchanged.

**Step 3 — verify**

```bash
# Current signing key is the new one.
stellar contract invoke --id "$ISSUER_REGISTRY_ID" --rpc-url "$RPC_URL" \
  --network-passphrase "$NETWORK_PASSPHRASE" \
  -- get_issuer_pubkey --issuer_id "$ISSUER_ADDRESS"

# Both the new key and the retired one still verify.
stellar contract invoke --id "$ISSUER_REGISTRY_ID" --rpc-url "$RPC_URL" \
  --network-passphrase "$NETWORK_PASSPHRASE" \
  -- is_valid_issuer_key --issuer_id "$ISSUER_ADDRESS" --pubkey "$NEW_PUBKEY_HEX"

# Full key set, current key first.
stellar contract invoke --id "$ISSUER_REGISTRY_ID" --rpc-url "$RPC_URL" \
  --network-passphrase "$NETWORK_PASSPHRASE" \
  -- get_issuer_keys --issuer_id "$ISSUER_ADDRESS"
```

Then confirm end to end that a credential **signed before** the rotation still
submits and reads back as verified (`is_verified(holder, credential_type)`).

**Step 4 — switch the signing environment**

Point issuance at the new key only after Step 3 passes. Credentials signed with
the old key after the window closes will be rejected, so the cutover must land
before `old_key_valid_until`. This is the moment to disable the old private key
in the KMS/HSM (§3) — nothing off-chain needs it anymore.

**Step 5 — keep the key history alive (keeper job)**

The retired-key history lives in a persistent entry with the contract's normal
entry lifetime (~120 days, refreshed by every rotation and revocation). When
that entry lapses, a retired key stops verifying even if its validity window is
still open — so a window longer than the entry lifetime needs periodic
maintenance:

```bash
stellar contract invoke --id "$ISSUER_REGISTRY_ID" --source "$ADMIN_KEY" \
  --rpc-url "$RPC_URL" --network-passphrase "$NETWORK_PASSPHRASE" --send yes \
  -- refresh_issuer_keys_ttl --issuer_id "$ISSUER_ADDRESS"
```

It is admin-only, emits no event, and only extends the entry lifetime — it
cannot change which keys are valid. §6 covers when to run it and what happens if
you don't.

### Notes and limits

- Up to **8 retired keys** are retained per issuer. Entries whose window has
  closed are pruned automatically on the next rotation, so a long-lived issuer
  can rotate repeatedly; you only hit the cap if you perform more than eight
  rotations whose windows overlap.
- A retired key cannot be re-installed as the current key
  (`KeyAlreadyRetired`) — that would revive credentials signed with it.
- Re-registering an existing issuer with a *different* pubkey is rejected
  (`KeyChangeRequiresRotation`). Re-registration still updates credential types.
  This is deliberate: it is the path that used to invalidate credentials
  silently.
- Rotation does not un-revoke a revoked issuer; a fully revoked issuer stays
  revoked regardless of its key set.

---

## 5. Procedure B — emergency revocation (compromise)

Use this when a signing key may be in someone else's hands. Revocation is
immediate and idempotency is explicit (a second attempt fails rather than
silently succeeding).

**Impact on outstanding credentials:** any credential signed by the revoked key
stops verifying on the next ledger, regardless of its validity window.
**Holders must act** — holders of revoked-key credentials need a credential
re-signed by a live key before they can prove anything again. Notify them
promptly (§7) rather than letting submissions fail silently.

**Step 1 — kill the key**

```bash
stellar contract invoke \
  --id "$ISSUER_REGISTRY_ID" \
  --source "$ADMIN_KEY" \
  --rpc-url "$RPC_URL" \
  --network-passphrase "$NETWORK_PASSPHRASE" \
  --send yes \
  -- revoke_issuer_key \
  --issuer_id "$ISSUER_ADDRESS" \
  --pubkey "$COMPROMISED_PUBKEY_HEX"
```

The key can be either:

- **a retired key** still inside its window — proofs signed with it stop
  verifying on the next ledger, even though the window has not closed. The
  issuer keeps issuing normally, and holders of credentials signed by that key
  are the only ones affected.
- **the current key** — the issuer can no longer issue: `is_valid_issuer`
  returns false, so no new submission for that issuer is accepted. The issuer is
  blocked until Step 2, and the admin performs Step 2 on its behalf.

**Step 2 — install a replacement key**

Run §4 with a freshly generated key. Because the current key was revoked, the
rotation records it in history as revoked (never valid) and clears the issuer's
blocked state. Outstanding credentials signed with *other*, non-revoked retired
keys keep verifying until their own windows close.

**Step 3 — investigate the blast radius**

Credentials signed with the revoked key no longer verify anywhere in the
protocol, including ones already submitted and cached: read them again with
`is_verified` after revoking rather than trusting a pre-incident cache. Ask
holders to re-derive their proofs with a credential signed by a live key
(§7 has the notice wording). Also disable the key material in the KMS/HSM so
the off-chain environment matches the on-chain state.

---

## 6. TTL maintenance — `refresh_issuer_keys_ttl`

**What it is for.** `IssuerRegistry` stores an issuer's record and its
retired-key history as Soroban *persistent* entries. Persistent entries have a
fixed lifetime (`ENTRY_TTL`, ~120 days) and are only extended when an
admin-role write touches them. Rotations and revocations extend them
automatically, but reads never do. `refresh_issuer_keys_ttl` is the admin-only
"bump" call that extends the issuer record, its retired-key list, and its
current-key-revoked flag without changing any key state. It emits no event.

**What happens if nobody calls it.** The persistent entries lapse together — the
retired-key history and the issuer record — and the keys inside them stop being
readable:

- Retired keys stop verifying even though their on-chain validity window is
  still open. Holders' otherwise-valid credentials then fail with
  `IssuerKeyMismatch`.
- Once the issuer record itself lapses, the issuer looks unregistered:
  `is_valid_issuer` returns false, `get_issuer_keys` returns empty, and
  `get_issuer_pubkey` panics with `IssuerNotFound`.

A lapse happens silently between rotations — reads do not warn, and no event
fires. It is data loss you have to notice and repair, not a graceful expiry.

**When to call it.** Any issuer whose retired-key window is longer than the
entry lifetime (~120 days) needs periodic bumps so the window stays covered.
Schedule a keeper job (a monthly cron is ample — well inside the 120-day
lifetime and the 30-day bump threshold) for every issuer that has rotated.
Issuers that have never rotated have no retired-key entry and nothing to
maintain unless their record is otherwise dormant.

---

## 7. Communicating with holders

Holders do not watch the chain; tell them what changed and whether they must do
anything. Key points: what happened, which credentials are affected, whether
the old key still verifies (and until when), and what the holder must do.

**Planned rotation — holders do not need to act**

> On `<date>` we rotated our credential-signing key. **You do not need to do
> anything.** Credentials we issued before the rotation remain valid and
> verifiable until their normal expiry (`<old_key_valid_until>`, at the latest).
> Any new credential you request is signed with the new key. No re-proof is
> required.

**Emergency revocation — affected holders must re-prove**

> On `<date>` we revoked our credential-signing key after a suspected
> compromise. Credentials issued under that key **stop verifying immediately**.
> If you hold one, it can no longer be used to prove anything; please re-request
> a credential from us so it is signed with our current key. Credentials signed
> with other keys are unaffected.

For a compromise, also say what is *not* a risk where you can (e.g. the
compromise was of a signing key, not of holder data) and give a support channel.
Coordinate with consumers/verifiers: they will see `IssuerKeyMismatch` for
affected proofs and need the same explanation.

---

## 8. Events to alert on

| Event | Topics | Meaning |
|---|---|---|
| `iss_reg.key_rot` | `("iss_reg", "key_rot")` | `EventIssuerKeyRotated { issuer, old_pubkey, new_pubkey, old_key_valid_until }` |
| `iss_reg.key_revk` | `("iss_reg", "key_revk")` | `EventIssuerKeyRevoked { issuer, pubkey, was_current, revoked_at }` |

Recommended alerts:

- **`key_revk`** — page immediately. This is either a compromise or a broken
  rotation; both need a human within minutes.
- **`key_rot`** — ticket for review. Confirm `old_key_valid_until` matches the
  issuer's outstanding credential expiries and that the cutover to the new
  signing key happened before the window closes.
- **`key_rot` for an issuer you did not schedule** — treat as `key_revk`.

Full event schemas: [EVENTS.md](../EVENTS.md).

---

## 9. Error codes

`IssuerRegistry` errors (see
[contract-error-codes.md](contract-error-codes.md) for the full table):

| Code | Variant | What to do |
|---|---|---|
| 6 | `KeyNotFound` | Key unknown to this issuer, or its window already closed — nothing to revoke. |
| 7 | `KeyAlreadyRevoked` | Already revoked; no action needed. |
| 8 | `KeyAlreadyRetired` | Refusing to re-install a live key from the history. |
| 9 | `KeyHistoryFull` | Eight retired keys are still inside their windows. Wait for one to expire, or revoke keys you no longer need. |
| 10 | `InvalidKeyWindow` | Window is empty or longer than 366 days. |
| 11 | `KeyAlreadyCurrent` | The new key is already current — nothing to rotate. |
| 12 | `KeyChangeRequiresRotation` | `register_issuer` cannot change a pubkey. Use `rotate_issuer_key`. |

`ProofRegistry` reports `IssuerKeyMismatch` (code 5) when the key in a proof's
public inputs is not in the issuer's live key set — either the window closed or
the key was revoked. It reports `IssuerNotTrusted` (code 4) when the issuer
itself is revoked or its current key was revoked.

---

## 10. Dry run on testnet

The contract tests in `contracts/issuer_registry/src/test.rs` and
`contracts/proof_registry/src/test.rs` cover both paths end to end, including
"a credential signed before the rotation still submits":

```bash
cargo test -p issuer_registry
cargo test -p proof_registry
```

For a manual testnet rehearsal, deploy to testnet, register an issuer, submit a
proof, then rotate and re-submit the same proof: it must still verify. Repeat
with `revoke_issuer_key` on the signing key: the submission must fail.
