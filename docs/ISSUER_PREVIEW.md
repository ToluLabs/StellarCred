# Issuer Preview Mode

The issuer package supports an optional **preview** mode for sandbox and test
environments. Preview mode runs the full attribute-mapping and commitment
derivation pipeline but **never signs** a credential and **never touches issuer
private key material or external signing providers**.

## Why preview mode?

- Validate commitment generation and attribute mapping without deploying keys.
- Inspect the exact payload structure that would be signed in production.
- Test integrations in sandbox environments with zero signing risk.
- Get deterministic output for test assertions (pass an explicit `issuedAt`).

## API surface

```ts
import { issueCredential, buildPayload } from "@packages/issuer";
```

The core entry point is `issueCredential(request, signer, options)`.

- **Normal issuance**: pass a signer. The signer is invoked on the canonical
payload and the result includes a signature.
- **Preview issuance**: set `preview: true` in the request. The signer is
ignored and the result has `signature: null`.

### Request shape

```ts
interface IssueRequest {
  subjectId: string;
  attributes: Record<string, string | number | boolean>;
  schemaId?: string;
  issuerId?: string;
  preview?: boolean;
  expiresAt?: number;
}
```

## Example: sandbox preview issuance

```ts
import { issueCredential } from "@packages/issuer";

async function preview() {
  const result = await issueCredential(
    {
      subjectId: "user-123",
      attributes: {
        KycLevel: "tier-2",
        Residency: "US",
      },
      schemaId: "sandbox-schema",
      issuerId: "sandbox-issuer",
      preview: true,
    },
    undefined,
    { issuedAt: 1700000000 }, // fixed timestamp for determinism in tests
  );

  console.log(result.mode); // "preview"
  console.log(result.signature); // null
  console.log(result.publicInputs.commitment);
  console.log(result.metadata);
}
```

## Example: HTTP route integration

`POST /api/issue` accepts `preview: true` for sandbox integrations that need to
exercise attribute mapping and commitment generation without signing.

```json
{
  "preview": true,
  "type": "age",
  "holder": "G...",
  "issuerId": "G...",
  "attributes": { "date_of_birth": "1995-06-15" },
  "claimParams": { "threshold_years": "21" }
}
```

The endpoint returns HTTP 200 with `preview: true` and unsigned credential
metadata, including the generated commitment, claim label, and preview
`publicInputs`. It uses the issuer package's normal attribute mapping and
commitment construction. A random salt is used per request, so repeated
requests produce different commitments.

Preview mode does not construct an issuer client or use `ISSUER_PRIVATE_KEY`,
call Persona or Plaid, fetch issuer registry state, sign, or append issuance
audit records. The shared route environment loader still parses configured
environment values at startup. Preview omits the credential value, salt, signature, and issuer
public-key bytes. Consequently, a preview response is not a credential and
cannot be used to produce a valid proof; real issuance with `preview` omitted
is unchanged.

The `publicInputs` object is preview metadata containing the commitment,
holder, and issuer ID. It is not a complete circuit input vector: the issuer's
signing public key is intentionally unavailable on this no-key path.

## Guarantees

- Preview mode **never calls the signer**. The signer is only invoked on the
  non-preview path.
- Preview mode **never reads issuer private key material**. The issuer package
  accepts a signer abstraction and never imports key storage.
- Attribute mapping is shared between preview and normal issuance via
  `mapAttributes` and `buildPayload`, so preview output matches the payload
  that would be signed.
- Output is deterministic for a fixed `issuedAt` and input, making it safe
  for snapshot and regression tests.

## Testing

The package is covered by targeted tests that assert:

1. Preview mode returns `signature: null` and `mode: "preview"`.
2. Preview mode never invokes the signer (a spy signer that throws if called).
3. Preview output is deterministic for a fixed `issuedAt`.
4. Normal issuance still signs and returns a signature (no regression).
5. Preview and normal paths share identical `publicInputs` and `metadata`.