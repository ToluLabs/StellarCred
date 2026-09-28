# Issuer Lifecycle: What Happens When an Issuer Goes Away

This document defines the end-of-life policy for issuers in StellarCred and
describes what holders should do when their issuer becomes unavailable.

Applies to `IssuerRegistry` (v1.1.0+) and `ProofRegistry`. Related reading:
[ISSUER_KEY_ROTATION.md](ISSUER_KEY_ROTATION.md) for the operational key
management procedure.

---

## 1. Policy: two kinds of issuer unavailability

StellarCred distinguishes **retirement** (graceful, planned) from
**compromise** (emergency, immediate) at both the issuer level and the key
level, mirroring the distinction the key-rotation system already makes between
`rotate_issuer_key` and `revoke_issuer_key`.

### 1.1 Issuer retirement (graceful shutdown)

An issuer that is shutting down cooperatively should:

1. Stop issuing new credentials.
2. Inform existing holders (off-chain, via their website or notification
   channel) that credentials will no longer be provable after a given date.
3. Ask the protocol admin to run `revoke_issuer` once all outstanding
   credentials have naturally expired — or sooner if the issuer consents to
   invalidating any remaining credentials.

After `revoke_issuer` executes:

- `IssuerRegistry.is_valid_issuer(issuerId, credentialType)` returns `false`.
- `ProofRegistry.submit_proof` rejects any new submission for this issuer with
  `IssuerNotTrusted` (error code 4).
- Proofs already cached on-chain remain readable via `is_verified` until their
  stored `expiry` passes — the submission gate and the cache read are
  separate operations.

**Policy:** existing credentials held by holders are *not* retroactively made
provable past the point of revocation. The registry gate is intentional:
once an issuer is revoked, new proof submissions for their credentials are
rejected to prevent stale or unverifiable attestations from entering the
protocol.

### 1.2 Key compromise (emergency)

An issuer whose signing key was compromised must be treated as a security
incident. The admin runs `revoke_issuer_key` on the compromised key. If that
key was the issuer's *current* signing key, the issuer is immediately blocked
(`is_valid_issuer` returns `false`) until the admin installs a replacement via
`rotate_issuer_key`.

Credentials signed with the revoked key cannot be submitted to `ProofRegistry`:
the circuit embeds the signing key as a public input and `is_valid_issuer_key`
rejects it immediately.

Holders of credentials signed by the revoked key must obtain a fresh credential
from the same issuer (once they have rotated to a new key) or from a different
trusted issuer.

### 1.3 Key rotation (normal key hygiene)

This is **not** an issuer going away. Key rotation retires the old key with a
validity window covering outstanding credentials' natural expiry. The issuer
remains active; proofs for credentials signed with the old key continue to
succeed until the window closes. No holder action is required unless the window
is set shorter than their credential's expiry.

See [ISSUER_KEY_ROTATION.md §3](ISSUER_KEY_ROTATION.md) for the rotation
procedure.

---

## 2. On-chain state that drives the signal

| State | `is_valid_issuer` | Proof submission | Cause |
|---|---|---|---|
| Issuer active, key active | `true` | succeeds | normal operation |
| Current key rotated, window open | `true` | succeeds (old key still valid) | routine rotation |
| Current key rotated, window closed | `true` | fails `IssuerKeyMismatch` | old credential, rotation window expired |
| Current key emergency-revoked | `false` | fails `IssuerNotTrusted` | compromise |
| Issuer revoked | `false` | fails `IssuerNotTrusted` | retirement or misconduct |

---

## 3. What the holder UI surfaces

The holder page checks issuer status in the background using two read-only
Soroban simulations per credential (no wallet signature required):

1. `IssuerRegistry.is_valid_issuer(issuerId, credentialType)` — issuer-level
2. `IssuerRegistry.is_valid_issuer_key(issuerId, pubkey)` — key-level

The result is stored on the credential as `issuerStatus` and refreshed
periodically (every 5 minutes; always refreshed for any non-active status).

### Status values

| `issuerStatus` | UI signal | Holder action |
|---|---|---|
| `"active"` | No warning — normal prove button | None |
| `"key_retired"` | No warning — proving still works | None; get a new credential before the rotation window closes if desired |
| `"key_revoked"` | **Red badge** "Issuer key revoked" on credential card; red warning banner in ProofFlow | Obtain a new credential from the same issuer (once they rotate) or from a different issuer |
| `"issuer_revoked"` | **Red badge** "Issuer revoked" on credential card; red warning banner in ProofFlow | Obtain a new credential from a different trusted issuer |
| `"unknown"` | No warning (treated conservatively — network may be unreachable) | None; try again when connected |

A dedicated **"Issuer gone · credential affected"** section appears at the top
of the credential list when any credential has `issuerStatus` of
`"issuer_revoked"` or `"key_revoked"`, along with a summary banner.

### In-proof warning

When the holder navigates to the ProofFlow for a credential with an affected
issuer status, a red alert is shown **before** any proving starts:

> **Issuer has been removed** — *[Issuer name]* has been permanently removed
> from the registry. Proof submission will fail. Obtain a new credential from
> a different trusted issuer.

Proving is not blocked — the holder may still attempt it (e.g. to confirm the
status or because the issuer was re-registered) — but they are clearly warned.

---

## 4. What a holder should do

### When `issuerStatus` is `"issuer_revoked"`

The issuer is permanently gone from this deployment's registry. Your credential
is a valid attestation of a true fact, but it cannot be submitted on-chain.

1. **Contact the issuer** (if they are reachable) to understand whether they
   intend to re-register or to direct holders to a successor issuer.
2. **Obtain a fresh credential** from another trusted issuer listed at
   `/verify`. The claim itself (e.g. KYC-complete, age ≥ 18) only needs to be
   re-issued, not re-verified from scratch if you already hold an attestation.
3. **Remove the old credential** from your wallet once you have the new one.
   It can no longer be proved and has no on-chain value.

### When `issuerStatus` is `"key_revoked"`

The issuer's signing key was emergency-revoked. The issuer may still be
operating and intending to issue new credentials once the admin installs a
replacement key.

1. **Wait** a short period — key revocation is usually followed by an
   immediate rotation to a new key (see §4 of the key-rotation runbook).
2. **Refresh** the holder page after a few minutes. If the issuer has
   rotated to a new key, status will return to `"active"` and you can prove
   normally.
3. **Contact the issuer** if status remains `"key_revoked"` after 24 hours.
4. **Obtain a fresh credential** if the issuer cannot recover — either from
   the same issuer once they are operational again, or from a different trusted
   issuer.

### When `issuerStatus` is `"key_retired"` (rotation, window still open)

No action needed now. Your credential still proves. Be aware that once the
rotation window closes, submission will fail with `IssuerKeyMismatch`. If you
want to be safe:

- Re-prove and submit on-chain before the window closes.
- Or obtain a new credential signed by the issuer's current key.

---

## 5. Finding another trusted issuer

All active trusted issuers for each credential type are listed at `/verify`
(the "Get a credential" page). The page calls `IssuerRegistry.get_issuers()`
and filters to only show non-revoked issuers, so a revoked issuer's name does
not appear there.

If you need a specific credential type (e.g. KYC) and only one issuer is
listed, the protocol's trust list may need to be expanded. Contact the protocol
admin via the governance channel listed at the bottom of the site.

---

## 6. For protocol administrators

When revoking an issuer, consider:

1. **Notify holders** off-chain before revoking, whenever possible.
2. **Set a sunset date** after which no new credentials will be issued. Give
   holders enough time to re-obtain credentials from another issuer.
3. **Run `revoke_issuer`** only after the sunset date passes, or immediately
   in a compromise scenario.
4. **Update the issuer list** at `/verify` — revoked issuers are filtered
   automatically, but ensure another issuer for the same credential type is
   listed so holders have a path forward.

When revoking a key (compromise scenario), follow the full procedure in
[ISSUER_KEY_ROTATION.md §4](ISSUER_KEY_ROTATION.md#4-procedure-b--emergency-revocation-compromise).

---

## 7. Contract error codes

| Code | Variant | Context |
|---|---|---|
| 4 | `IssuerNotTrusted` | ProofRegistry — issuer is revoked or its current key is revoked |
| 5 | `IssuerKeyMismatch` | ProofRegistry — the key in the proof is not in the issuer's live key set |

Full table: [contract-error-codes.md](contract-error-codes.md).

---

## 8. Related documents

- [ISSUER_KEY_ROTATION.md](ISSUER_KEY_ROTATION.md) — operational procedure for
  key rotation and emergency revocation
- [EVENTS.md](../EVENTS.md) — event schemas for `iss_reg.revoked`,
  `iss_reg.key_revk`, `iss_reg.key_rot`
