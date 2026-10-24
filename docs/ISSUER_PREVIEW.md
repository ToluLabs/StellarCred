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

The `/api/issue` route forwards the `preview` flag from the JSON body into
`issueCredential`. When preview is enabled no signer is constructed and no
signing key is read.

```bash
curl -X POST http://localhost:3000/api/issue /
  -H 'Content-Type: application/json' -
  -d '{
    "subjectId": "user-123",
    "attributes": { "kycLevel": "tier-2" },
    "schemaId": "sandbox-schema",
    "issuerId": "sandbox-issuer",
    "preview": true
  }'
```

Response (200):

```json
{
  "mode": "preview",
  "commitment": "<hex>",
  "publicInputs": {
    "commitment": "<hex>",
    "subjectCommitment": "<hex>",
    "schemaCommitment": "<hex>",
    "expiresAt": null
  },
  "metadata": {
    "issuerId": "sandbox-issuer",
    "schemaId": "sandbox-schema",
    "subjectId": "user-123",
    "attributes": { "kyclevel": "tier-2" },
    "issuedAt": 1700000000,
    "expiresAt": null,
    "version": "preview/v1"
  },
  "signature": null
}
```

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
