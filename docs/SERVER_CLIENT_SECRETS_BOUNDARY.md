# Server-Only vs Client-Bundled Secrets Boundary

This document specifies the architectural boundary between server-side operations and client-side execution in StellarCred, guarding against secret leaks into client bundles (#976).

---

## 1. Architectural Boundary

StellarCred operates a zero-knowledge credential architecture where:
- **Server-Side Boundary**: Issuer authority signing keys and administrative credentials remain strictly isolated on the server. The server issues attested credentials and generates witness values using private keys that must never be transmitted or bundled into client code.
- **Client-Side Boundary**: Holders generate zero-knowledge proofs locally in their browsers using public circuit artifacts and WebAssembly (WASM). Holders never possess or need access to issuer private keys.

---

## 2. Forbidden Secrets in Client Bundles

The following patterns and keys are strictly prohibited from client bundles and public artifacts:

1. **Private Keys & Signing Seeds**:
   - `ISSUER_PRIVATE_KEY` / `ISSUER_SECRET`
   - Ed25519 or secp256k1 private key PEM blocks (`BEGIN PRIVATE KEY`)
   - Raw private seed byte arrays or hex strings
2. **Administrative Credentials**:
   - `ADMIN_API_KEY`
   - Database connection strings (`DATABASE_URL`, `POSTGRES_URL`)
   - Secret webhook signing keys (`WEBHOOK_SECRET`)
   - Internal JWT signing secrets (`JWT_SECRET`)
3. **Environment Variable Naming Rules**:
   - Next.js automatically bundles any environment variable prefixed with `NEXT_PUBLIC_` into the client JavaScript build.
   - Therefore, **NO secret, private key, or administrative credential may ever use the `NEXT_PUBLIC_` prefix**.

---

## 3. Automated CI Enforcement

An automated verification scanner (`frontend/scripts/assert-no-issuer-secrets-in-bundle.mjs`) is executed during CI build validation:
1. Inspects the compiled Next.js client bundles (`.next/static/` or source client modules).
2. Verifies that zero forbidden environment variable names or private key patterns appear in client assets.
3. Fails CI builds immediately if any secret-shaped pattern or forbidden prefix is detected.
