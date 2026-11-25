# Verification Return URL Policy & Security Specification

This document defines the security model, scheme restrictions, origin validation rules, and privacy guarantees for shareable verification return URLs in StellarCred (#978).

---

## 1. Overview and Threat Model

A shareable verification return URL directs a user back to an integrator dApp or website after a credential verification flow completes. Without strict validation, return URLs can be exploited for:
- **Open Redirects**: Directing users to malicious external destinations using protocol-relative paths (`//evil.com`) or backslash escapes.
- **Cross-Site Scripting (XSS)**: Execution of arbitrary client scripts via `javascript:`, `data:`, or `vbscript:` pseudo-protocols.
- **Credential / Token Leakage**: Leaking sensitive attributes or authorization tokens into secondary redirect query parameters.

---

## 2. Allowed Schemes and Origin Policies

Return URLs are evaluated against the following strict criteria:

1. **Protocol Restrictions**:
   - Relative paths (e.g., `/dashboard`, `/verify/callback`) are permitted and strictly bound to the application's `currentOrigin`.
   - Protocol-relative URLs starting with `//`, `/\\`, or `\\\\` are strictly rejected.
   - External URLs must use the `https:` protocol. Plain `http:` is forbidden for external targets.
   - Dangerous schemes (`javascript:`, `data:`, `vbscript:`, `file:`, `blob:`) are unconditionally rejected.
2. **Authority and Credential Sanitization**:
   - URLs containing userinfo/embedded credentials (`https://trusted.com@attacker.com`) are rejected.
3. **Open Redirect Boundary**:
   - When a relative URL is resolved against `currentOrigin`, the resulting URL origin must match `currentOrigin` exactly.

---

## 3. Query Parameters and Privacy Model

Upon successful verification, StellarCred appends only safe, documented query parameters to the return URL:

| Query Parameter | Format | Description | Privacy Guarantee |
|:---|:---|:---|:---|
| `sc_verified` | `"true"` | Boolean flag indicating successful verification. | Contains no user data. |
| `sc_wallet` | Stellar Public Key (`G...`) | Public address of the verifying wallet. | Public on-chain identifier only. |
| `sc_claims` | Comma-delimited strings | Types of credentials verified (e.g. `kyc,age`). | Type labels only; never raw attribute values or commitments. |

### Forbidden Data in Return URLs
The following fields are strictly prohibited from appearing in return URL query strings or hashes:
- Raw attribute values (birthdates, income numbers, balances)
- Cryptographic salts and blinding factors
- Issuer signatures or private keys
- Session passphrases or backup envelopes

---

## 4. Implementation Reference

Validation is performed by `validateReturnUrl` in `frontend/lib/verify-redirect.ts` and covered by automated regression tests in `frontend/lib/__tests__/verify-redirect-security.test.ts`.
