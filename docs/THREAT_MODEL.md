# Threat Model

This document records the assets StellarCred protects, the trust boundaries it crosses, the adversaries it must resist, and the mitigations the implementation relies on. It is intended to be read together with [SECURITY.md](../SECURITY.md) and the repository PR checklist.

## Assets

| Asset | Why it matters |
|---|---|
| Issuer signing key | Signs credentials off-chain; compromise lets an attacker mint apparently valid credentials. |
| Credential secrets | The value and salt used to derive commitments; disclosure breaks privacy and replay resistance. |
| Holder identity fields | KYC-provided fields such as name, date of birth, or jurisdiction; exposure causes privacy harm. |
| On-chain trust root | The `IssuerRegistry` state, registered issuer public keys, and credential-type bindings that define which issuers are trusted. |

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

## Residual Risks and Assumptions

- The KYC provider is trusted to perform identity verification correctly and to return honest results.
- The browser environment is assumed to be integrity-preserving enough for local proof generation; a fully compromised device can still exfiltrate user inputs before they are proven.
- TLS, DNS, and the user’s network path are assumed to be available and correctly configured; transport security reduces but does not eliminate MITM risk.
- On-chain security assumes the Soroban chain and the deployed contracts execute as intended and that contract administration keys are protected separately from issuer keys.
- Privacy depends on the implementation continuing to avoid server-side storage of identity fields beyond the minimum data needed for issuance.

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