# Threat Model

This document records the assets StellarCred protects, the trust boundaries it crosses, the adversaries it must resist, and the mitigations the implementation relies on. It is intended to be read together with [SECURITY.md](../SECURITY.md) and the repository PR checklist.

## Assets

| Asset | Why it matters |
|---|---|
| Issuer signing key | Signs credentials off-chain; compromise lets an attacker mint apparently valid credentials. |
| Credential secrets | The value and salt used to derive commitments; disclosure breaks privacy and replay resistance. |
| Holder identity fields | KYC-provided fields such as name, date of birth, or jurisdiction; exposure causes privacy harm. |
| On-chain trust root | The `IssuerRegistry` state, registered issuer public keys, and credential-type bindings that define which issuers are trusted. |
| Delegation grants (holder ↔ verifier links) | The record of which verifier a holder has authorized, via `grant_verification`, to read a claim result. On-chain by construction, so its *confidentiality* cannot be protected — but its *integrity* (only the holder can create or revoke it) must be. |

## Trust Boundaries

| Boundary | What crosses it | Security concern |
|---|---|---|
| Browser ↔ API route | Holder data, proof inputs, and issuance requests | The browser is untrusted for confidentiality and can be tampered with; the API must not leak server-only secrets or store unnecessary identity data. |
| API route ↔ KYC provider | Identity verification result and holder attributes | The API depends on the provider for correct identity assertions, but should only retain the minimum data needed to derive the credential. |
| Contracts ↔ chain | Proof submissions, registry updates, and verification reads | On-chain state is the trust root for protocols, so proofs and issuer registrations must be authenticated and replay-safe. |

## Adversaries

| Adversary | Goal |
|---|---|
| Malicious holder | Forge a proof, replay someone else’s credential, or bypass the issuer signature check. |
| Malicious protocol | Misuse verification APIs, over-request claims, or infer identity data from protocol integration. |
| Compromised issuer key | Mint credentials for arbitrary holders or credential values. |
| Network MITM | Alter API responses, redirect issuance flows, or tamper with proof submission traffic. |
| Malicious issuer | Issue false credentials, violate policy, or attempt to register unauthorized keys. |
| Curious verifier or third-party chain observer | Learn which verifier a holder has delegated to (and for how long) by reading `Delegation` storage or `dlg_grant`/`dlg_revok` events, or infer behavior by polling `check_delegated_verification` — without needing a valid delegation to do so. |
| Verifier with a compromised operational key | Exploit an off-chain relying party that grants privileges to "the address a holder delegated to," for as long as the on-chain grant remains live. |

## Threats and Mitigations

| Threat | Mitigation |
|---|---|
| Forged proof accepted on-chain | The issuer signature is checked inside the circuit with `std::ecdsa_secp256k1`, and the contract verifies that the public key in the public inputs matches the issuer registered in `IssuerRegistry`. A proof is only valid when it binds to a registered issuer. |
| Replayed or stale proof submission | ProofRegistry stores verification state with expiry and the protocol reads the cached on-chain result instead of trusting a client-side assertion. Expiration must be aligned with ledger timing and proof freshness requirements. |
| Stolen issuer key | Store `ISSUER_PRIVATE_KEY` in a secrets manager or HSM-backed environment, rotate it through `IssuerRegistry.register_issuer`, and revoke the old key immediately if compromise is suspected. |
| Identity leakage | The API must not persist or log holder identity fields after the KYC call returns, and only the fields required to derive the credential should be handled. The PR checklist explicitly reviews this behavior. |
| Network MITM | Keep the browser/API and API/provider interactions on authenticated TLS channels, avoid exposing server-side secrets to the client, and treat all client inputs as attacker-controlled. |
| Malicious issuer registers the wrong public key | `IssuerRegistry` is the sole on-chain trust root for issuer binding, so issuer registration is an administrative action and contracts reject issuers that are not registered with the expected credential types. |
| Malicious protocol infers more than the verified claim | Protocols only receive the on-chain boolean or threshold result, not raw credential data. The public interface is intentionally limited to `is_verified` / `check_claim`. |
| Grant records deanonymize a holder–verifier relationship | None at the contract layer, and none is possible under this design — Soroban persistent storage and contract events are public ledger data, so `Delegation(holder, verifier, credential_type)` entries and the `dlg_grant`/`dlg_revok` events are enumerable by anyone with RPC or indexer access. This is a stated, accepted trade-off (see "Delegated Verification" below), not a bug to be fixed. |
| Anyone can query a delegation, not just the named verifier | `check_delegated_verification` performs no `require_auth` on its caller — this mirrors `is_verified` already being an unauthenticated public read. The delegation controls whose *consent is on record*, not who may *query the chain*; relying parties must not treat "the call named verifier V" as proof the caller is V. |
| Verifier key compromised during a live grant | The holder is the only party who can shorten the exposure window (`revoke_verification`); the contract cannot detect key compromise or auto-revoke. Short-lived grants bound the blast radius (see recommended practice below). |

## Delegated Verification (#396)

Delegated verification (`grant_verification` / `revoke_verification` / `check_delegated_verification`) lets a holder authorize a specific verifier to read one credential type's result until a chosen expiry. It is additive — `is_verified` keeps working exactly as before for every caller — and it does not introduce a new confidentiality boundary, because Soroban contract storage was never confidential to begin with: `is_verified` was already a public, unauthenticated read before this feature existed. What delegation adds is a new *public fact* — "holder H has named verifier V for credential type C, until time E" — not a new *private* one.

**What a grant reveals publicly.** A successful `grant_verification` call, and the `Delegation` storage entry it writes, are part of ordinary public ledger state:

- The `EventVerificationGranted` / `EventVerificationRevoked` events are visible to any indexer or RPC client watching the contract, with no query authorization required.
- The underlying `Delegation(holder, verifier, credential_type)` storage entry can be read directly from ledger state by anyone who knows or enumerates the triple, independent of calling `check_delegated_verification`.
- Repeated `check_delegated_verification` calls by anyone (not only the named verifier — see below) can be used to fingerprint when a grant became active, changed, or was revoked, by diffing results over time.

**Is on-chain enumerability of grants acceptable?** Yes, given the surrounding design, but it is a real privacy cost that holders and integrators should weigh deliberately rather than assume away:

- The system's privacy guarantee has always been about the *claim's contents* (commitment, threshold, identity fields), not about *who is transacting with whom*. Delegation doesn't regress claim-content privacy — `check_delegated_verification` returns the same `(bool, verified_at, expiry)` shape as `is_verified`, never raw credential data.
- The genuinely new disclosure is the *relationship* itself: that a specific holder chose a specific verifier. That is unavoidable on a public ledger without adding off-chain infrastructure (e.g., encrypted grant metadata, a commit-reveal scheme, or a side channel between holder and verifier), none of which this feature implements.
- Because that visibility can't be removed under the current design, it is accepted as a documented trade-off. Integrators who need to hide *that a relationship exists* — not just its content — should not rely on on-chain delegation for that purpose, and should instead negotiate authorization off-chain and use this contract only to gate the object it protects.

**Guarantees.**

- Only the holder, via `require_auth`, can create or revoke a grant on their own claims; a verifier cannot self-grant access.
- A grant is scoped to exactly one `(holder, verifier, credential_type)` triple and one expiry — it cannot be reused for a different verifier or credential type.
- `check_delegated_verification` reflects the *live* state of the underlying claim: revoking the claim (`revoke_proof`) or letting it expire invalidates the delegated view even while the grant's own expiry is still in the future.
- Delegated access is time-bounded: `grant_verification` reuses the same `validate_expiry` check as claim submission, so a grant can extend no more than `MAX_CREDENTIAL_TTL_SECS` (365 days) into the future.
- The delegated read exposes no more than the already-public `is_verified` result — a boolean plus `verified_at` / `expiry` — never the commitment, threshold, or issuer identity fields.

**Non-guarantees.**

- **Not confidential.** As above, both the grant and its lifecycle events are public ledger data. Treat every grant as a permanent (until any future pruning), public record linking two addresses.
- **Not caller-restricted.** `check_delegated_verification` takes `verifier` as a plain argument with no `require_auth` on the caller, so any address can query any `(holder, verifier, credential_type)` triple. A relying party cannot infer "this request came from the verifier" from the fact that a delegated check returned `true`.
- **No compromise detection.** If a verifier's off-chain signing key is compromised while a grant is live, the contract has no way to detect or react to that. An attacker holding the compromised key can exercise whatever off-chain privilege a relying party attaches to "the address the holder delegated to" for the rest of the grant window.
- **No single-query proof of "never granted."** `check_delegated_verification` and the absence of a current `Delegation` entry only describe *present* state. A grant that was created and later revoked or left to expire leaves no trace in current storage, so a holder cannot prove non-grant with a single read. Doing so requires reconstructing the full `dlg_grant` / `dlg_revok` event history for the address pair from an archival indexer; most public RPC providers retain live event history for a limited window (on the order of days), so this gets harder to demonstrate the further back the period in question is.

**Recommended grant duration and revocation practice.**

- Default to the shortest expiry the verifier's workflow actually needs (hours to a few days), not the one-year maximum `validate_expiry` allows. Surface the chosen expiry to the holder before they authorize it.
- Treat every grant as a public, indefinite disclosure of "I am dealing with this verifier," and confirm the holder is comfortable with that link being publicly visible before submitting it.
- Revoke explicitly (`revoke_verification`) once a verifier's need has passed rather than waiting for expiry — revocation is immediate, while an un-revoked grant remains queryable (though functionally inert against a revoked or expired underlying claim) until its own expiry.
- If a verifier's operational key is suspected compromised, the holder should revoke every delegation to that verifier immediately. Relying parties should not treat "request signed by the verifier's known key" as sufficient proof of continued authorization on its own — re-check `check_delegated_verification` at time of use.
- Integrations should re-check `check_delegated_verification` per use rather than caching a "delegated" result, since both the grant and the underlying claim can be revoked independently at any time.

## Residual Risks and Assumptions

- The KYC provider is trusted to perform identity verification correctly and to return honest results.
- The browser environment is assumed to be integrity-preserving enough for local proof generation; a fully compromised device can still exfiltrate user inputs before they are proven.
- TLS, DNS, and the user’s network path are assumed to be available and correctly configured; transport security reduces but does not eliminate MITM risk.
- On-chain security assumes the Soroban chain and the deployed contracts execute as intended and that contract administration keys are protected separately from issuer keys.
- Privacy depends on the implementation continuing to avoid server-side storage of identity fields beyond the minimum data needed for issuance.
- Delegated verification grants and their lifecycle events are assumed to be public and permanently observable on-chain (see "Delegated Verification" above); no future change should present `grant_verification` to holders as a confidential or off-the-record action.

## Reviewer Checklist

Use this checklist during review to connect the PR template’s security items to the threats they mitigate.

| PR template item | Threat mitigated | What to verify |
|---|---|---|
| [No `NEXT_PUBLIC_` prefix on server-only env vars](../.github/pull_request_template.md#L19-L20) | Secret exposure, forged credentials | Confirm `ISSUER_PRIVATE_KEY` and similar server-only values never become client-side environment variables or browser-visible configuration. |
| [No identity fields stored or logged after KYC provider call](../.github/pull_request_template.md#L19-L20) | Identity leakage, privacy breach | Confirm the API handles only the minimum identity fields required for issuance and does not persist or log them after the provider response is processed. |

## Review Notes

- If a change touches proof generation, issuer registration, or issuance flow, re-check the forged-proof and key-compromise rows above.
- If a change touches the browser/API boundary, re-check the identity-leakage and MITM rows above.
- If a change touches contract verification or registry state, re-check the on-chain trust-root assumptions above.
- If a change touches `grant_verification`, `revoke_verification`, or `check_delegated_verification`, re-check the "Delegated Verification" section above — especially that no new confidentiality claim is implied for grants, and that the delegated read still exposes no more than `is_verified` does.