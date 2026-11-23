# Issuer Preview Mode

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
