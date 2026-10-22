# StellarCred issue roadmap

This is a lightweight prioritization of the open GitHub issues, not a delivery
date commitment. It was checked against the maintainer repository on
2026-09-28; issue state can change, so GitHub is authoritative.

## Priority order

Work from the top track down. **Security, privacy, correctness, and operational
defects take priority over new features**, regardless of issue labels or
difficulty. A feature should not displace an unresolved defect.

### 1. Mainnet blockers — release gates

The following issues were identified as mainnet blockers in the roadmap request.
All four currently show **closed** on GitHub; they are listed as completed gates,
not as open work. Verify the fix and its regression coverage when preparing a
release. Do not treat this list as a declaration that the whole product is
mainnet-ready.

- **BLOCKER — CLOSED:** [#523](https://github.com/ToluLabs/StellarCred/issues/523)
  Shared rate-limit and idempotency store.
- **BLOCKER — CLOSED:** [#522](https://github.com/ToluLabs/StellarCred/issues/522)
  Remove duplicate SDK claim-reading implementations.
- **BLOCKER — CLOSED:** [#627](https://github.com/ToluLabs/StellarCred/issues/627)
  Prove identity data is not retained or logged across issuance flows.
- **BLOCKER — CLOSED:** [#284](https://github.com/ToluLabs/StellarCred/issues/284)
  Decide and enforce safe credential storage at rest.

No other open issue is designated a confirmed mainnet blocker by this snapshot.
The production-hardening track below contains security and reliability defects
that should be triaged before release; promote any one to a release gate if its
impact warrants it.

### 2. Fix defects and harden production

Resolve security, privacy, correctness, reliability, and deployment gaps before
spending effort on new capabilities.

- **Security and privacy:** [#69](https://github.com/ToluLabs/StellarCred/issues/69)
  issuer signing-key Provenance/KMS/HSM; [#70](https://github.com/ToluLabs/StellarCred/issues/70)
  issuance rate limiting; [#72](https://github.com/ToluLabs/StellarCred/issues/72)
  API request validation; [#342](https://github.com/ToluLabs/StellarCred/issues/342)
  contract admin rotation; [#531](https://github.com/ToluLabs/StellarCred/issues/531)
  CSP; [#532](https://github.com/ToluLabs/StellarCred/issues/532)
  embed framing/origin controls; [#533](https://github.com/ToluLabs/StellarCred/issues/533)
  holder data-disclosure visibility; [#547](https://github.com/ToluLabs/StellarCred/issues/547)
  consolidate credential storage/encryption; [#628](https://github.com/ToluLabs/StellarCred/issues/628)
  avoid caching signed credentials in full responses; [#619](https://github.com/ToluLabs/StellarCred/issues/619)
  expiring, single-use verification links.
- **Correctness and resilience:** [#75](https://github.com/ToluLabs/StellarCred/issues/75)
  API health/readiness; [#163](https://github.com/ToluLabs/StellarCred/issues/163)
  validate circuit inputs; [#308](https://github.com/ToluLabs/StellarCred/issues/308)
  aggregate submission integration coverage; [#333](https://github.com/ToluLabs/StellarCred/issues/333)
  preserve indexer thresholds; [#521](https://github.com/ToluLabs/StellarCred/issues/521)
  replace the mock pool ledger; [#528](https://github.com/ToluLabs/StellarCred/issues/528)
  Persona webhook handling; [#534](https://github.com/ToluLabs/StellarCred/issues/534)
  track circuit constraints; [#550](https://github.com/ToluLabs/StellarCred/issues/550)
  strengthen reproducible-build checks; [#552](https://github.com/ToluLabs/StellarCred/issues/552)
  test/document storage TTL; [#555](https://github.com/ToluLabs/StellarCred/issues/555)
  prevent retry amplification; [#604](https://github.com/ToluLabs/StellarCred/issues/604)
  remove duplicate health routes; [#612](https://github.com/ToluLabs/StellarCred/issues/612)
  check indexer data integrity; [#624](https://github.com/ToluLabs/StellarCred/issues/624)
  unify operational sink configuration; [#634](https://github.com/ToluLabs/StellarCred/issues/634)
  explicit degraded mode when RPC is unavailable.
- **Required verification and CI:** [#31](https://github.com/ToluLabs/StellarCred/issues/31)
  shared circuit test harness; [#43](https://github.com/ToluLabs/StellarCred/issues/43)
  testnet verify/prove/submit E2E; [#215](https://github.com/ToluLabs/StellarCred/issues/215)
  frontend lint/tests in CI; [#599](https://github.com/ToluLabs/StellarCred/issues/599)
  contract fmt/clippy CI; [#607](https://github.com/ToluLabs/StellarCred/issues/607)
  record the reverted circuit change's root cause; [#621](https://github.com/ToluLabs/StellarCred/issues/621)
  clarify CI workflow ownership; [#642](https://github.com/ToluLabs/StellarCred/issues/642)
  verify browser-generated proofs on-chain.

### 3. Improve integration and contributor experience

Once the higher-priority defects are being addressed, make the existing product
easier to integrate, operate, and contribute to. This track also includes
maintenance that reduces the cost and risk of ongoing changes.

- **SDK and protocol integration:** [#129](https://github.com/ToluLabs/StellarCred/issues/129)
  SDK claim-read cache; [#138](https://github.com/ToluLabs/StellarCred/issues/138)
  OpenAPI/types; [#400](https://github.com/ToluLabs/StellarCred/issues/400)
  framework middleware; [#401](https://github.com/ToluLabs/StellarCred/issues/401)
  issuer/integrator CLI; [#402](https://github.com/ToluLabs/StellarCred/issues/402)
  generated SDK API reference; [#403](https://github.com/ToluLabs/StellarCred/issues/403)
  tree-shaking and bundle budget; [#404](https://github.com/ToluLabs/StellarCred/issues/404)
  typed errors; [#405](https://github.com/ToluLabs/StellarCred/issues/405)
  indexer GraphQL API; [#407](https://github.com/ToluLabs/StellarCred/issues/407)
  indexer webhooks; [#525](https://github.com/ToluLabs/StellarCred/issues/525)
  ProofRegistry API reference; [#611](https://github.com/ToluLabs/StellarCred/issues/611)
  indexer backfill; [#613](https://github.com/ToluLabs/StellarCred/issues/613)
  indexer data through the SDK; [#623](https://github.com/ToluLabs/StellarCred/issues/623)
  bundle-composition visibility; [#631](https://github.com/ToluLabs/StellarCred/issues/631)
  read-only SDK bundle; [#639](https://github.com/ToluLabs/StellarCred/issues/639)
  deployment capability descriptor; [#641](https://github.com/ToluLabs/StellarCred/issues/641)
  generated-client regeneration checks.
- **Docs, onboarding, and operations:** [#520](https://github.com/ToluLabs/StellarCred/issues/520)
  stale PR backlog; [#605](https://github.com/ToluLabs/StellarCred/issues/605)
  connect the existing docs content; [#608](https://github.com/ToluLabs/StellarCred/issues/608)
  clean up stale branches; [#637](https://github.com/ToluLabs/StellarCred/issues/637)
  align contributor onboarding with the toolchains; [#638](https://github.com/ToluLabs/StellarCred/issues/638)
  identify safe issues for contributors; [#640](https://github.com/ToluLabs/StellarCred/issues/640)
  document product boundaries; [#643](https://github.com/ToluLabs/StellarCred/issues/643)
  establish this roadmap.
- **Maintainability and UX polish:** [#513](https://github.com/ToluLabs/StellarCred/issues/513)
  reduce `HolderPageClient` complexity; [#530](https://github.com/ToluLabs/StellarCred/issues/530)
  split up `VerifyPageClient`; [#606](https://github.com/ToluLabs/StellarCred/issues/606)
  keep `HolderPageClient` maintainable; [#617](https://github.com/ToluLabs/StellarCred/issues/617)
  issuer credential preview; [#636](https://github.com/ToluLabs/StellarCred/issues/636)
  make the apps gallery extensible.

### 4. Add new capabilities

These are valuable product extensions, but should not outrank unresolved
security, privacy, correctness, or production-readiness work.

- **Holder and issuer experience:** [#18](https://github.com/ToluLabs/StellarCred/issues/18)
  holder empty states; [#131](https://github.com/ToluLabs/StellarCred/issues/131)
  localization; [#394](https://github.com/ToluLabs/StellarCred/issues/394)
  proof-history export; [#399](https://github.com/ToluLabs/StellarCred/issues/399)
  theme polish; [#413](https://github.com/ToluLabs/StellarCred/issues/413)
  offline holder app; [#420](https://github.com/ToluLabs/StellarCred/issues/420)
  WalletConnect and Ledger; [#557](https://github.com/ToluLabs/StellarCred/issues/557)
  integration dry-run; [#558](https://github.com/ToluLabs/StellarCred/issues/558)
  holder-controlled retention and wipe; [#618](https://github.com/ToluLabs/StellarCred/issues/618)
  pre-proof eligibility warning.
- **Credential and protocol capabilities:** [#79](https://github.com/ToluLabs/StellarCred/issues/79)
  nullifier support; [#390](https://github.com/ToluLabs/StellarCred/issues/390)
  date-range proof; [#391](https://github.com/ToluLabs/StellarCred/issues/391)
  jurisdiction preset; [#392](https://github.com/ToluLabs/StellarCred/issues/392)
  SDK claim events; [#393](https://github.com/ToluLabs/StellarCred/issues/393)
  revocation metadata; [#395](https://github.com/ToluLabs/StellarCred/issues/395)
  uniqueness attestation; [#414](https://github.com/ToluLabs/StellarCred/issues/414)
  income range proof; [#425](https://github.com/ToluLabs/StellarCred/issues/425)
  composite eligibility circuit; [#430](https://github.com/ToluLabs/StellarCred/issues/430)
  leaderboard-safe uniqueness; [#556](https://github.com/ToluLabs/StellarCred/issues/556)
  credential freshness; [#633](https://github.com/ToluLabs/StellarCred/issues/633)
  circuit versioning; [#635](https://github.com/ToluLabs/StellarCred/issues/635)
  revocation subscriptions.

## Credential lifecycle and renewal policy

This policy defines the standardised lifecycle for every StellarCred
credential, from issuance through expiration, renewal, and revocation. It
applies to issuers, holders, verifiers, and the indexer.

### Credential states

Every credential is in exactly one of these states. State is derived from
on-chain data and the issuer's published policy, not from local client clocks
alone.

| State       | Meaning                                                 |
| ------------ | ---------------------------------------------------------------|
| `issued`     | Valid and within its validity window.                           |
| `expiring`    | Within the renewal window and still valid.                       |
| `expired`     | Past the validity window and no longer accepted for new proofs.    |
| `revoked      | Explicitly invalidated by the issuer or admin before expiry.       |
| `replaced`    | Superseded by a renewed credential; kept for audit only.           |

### Validity windows

- **Default validity:** 12 months from the issuance timestamp unless the
  issuer publishes a shorter or longer window in its policy document.
- **Maximum validity:** 36 months. Issuers requesting a longer window must
  receive explicit approval from the protocol admin and record the justification
  in the issuer registry.
- **Minimum validity:** 1 day. Shorter windows are rejected at issuance to
  avoid credentials that expire before a holder can use them.
- **Clock source:** the ledger timestamp at issuance defines the start of the
  window. Verifiers must evaluate expiry against the latest ledger timestamp,
  not the holder's or verifier's local clock.

### Renewal window

- **Opening:** the renewal window opens 30 days before the expiry timestamp.
- **Closing:** the renewal window closes at the expiry timestamp. After that,
  the credential is `expired` and a new issuance flow is required.
- **Grace period:** no grace period extends the validity of a credential for
  verification. The window exists only to allow the holder to request renewal
  before expiry.
- **Renewal outcome:** a successful renewal issues a new credential and marks
  the previous one `replaced`. The new credential receives a fresh validity
  window and its own identifier; the old identifier is never reused.
- **Required reattestation:** renewal must re-run the issuer's current
  eligibility checks. Renewal is not an automatic extension of the prior grant.

### Revocation and trust

- **Revocation authority:** only the issuing issuer or a protocol admin acting
  through the admin rotation process may revoke a credential. Holders and
  verifiers cannot revoke.
- **Revocation record:** every revocation records the credential identifier,
  the authority, the ledger timestamp, and a reason code. Records are
  append-only and publicly verifiable.
- **Trust revocation:** revoking an issuer's signing key or trust registration
  invalidates all credentials it issued that are still within their validity
  window. Verifiers must treat those credentials as `invalid` immediately.
- **Propagation:** revocation and trust-revocation events are published to the
  indexer and are available through the SDK and revocation subscriptions
  within one indexer checkpoint.

### Verifier requirements

- Verifiers must reject credentials that are `expired`, `revoked`, or
  `replaced`, and must reject credentials from a revoked trust registration.
- Verifiers must check the revocation state at the time of verification, not
  cache a valid result beyond the credential's expiry timestamp.
- Verifiers should surface the `expiring` state to holders so renewal can be
  completed in time.

### Holder responsibilities

- Holders are notified when a credential enters the renewal window.
- Holders must complete renewal before the expiry timestamp; after expiry the
  credential cannot be renewed and a new issuance flow is required.
- Holders may delete a credential locally at any time; deletion does not
  revoke the on-chain record.

### Operational guarantees

- Expiry and renewal state transitions are deterministic given the ledger
  timestamp and the issuer policy.
- Revocation and trust-revocation events are idempotent and safe to replay.
- The indexer must expose the current state of every credential and the current
  trust status of every issuer registration.

## How to use this roadmap

Pick work from the highest track that matches your skills. Labels such as
`.easy`, `medium`, and `hard` describe effort, not priority. Before starting,
check that the issue is still open and not already being handled by an active
pull request.
