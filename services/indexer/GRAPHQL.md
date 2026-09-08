# GraphQL endpoint

The indexer exposes a GraphQL endpoint at `/graphql` that provides typed,
flexible queries over the same claims store used by the REST API.

Schema (high level):

- Query `claims(...) : ClaimPage!`
  - Arguments:
    - `wallet: String` — exact wallet address to filter on
    - `credential_type: String` — credential type (e.g. `kyc`, `age`)
    - `issuer: String` — issuer public key
    - `active: Boolean` — `true` to return active (non-revoked) claims, `false` for revoked
    - `verifiedFrom: Int` — unix seconds lower bound (inclusive) for `verified_at`
    - `verifiedTo: Int` — unix seconds upper bound (inclusive) for `verified_at`
    - `limit: Int` — max rows to return (default 20, server-clamped)
    - `offset: Int` — offset for pagination (default 0)
  - Returns `ClaimPage { claims: [Claim], total: Int, limit: Int, offset: Int }`

`Claim` fields: `id`, `wallet`, `credential_type`, `issuer`, `verified_at`, `expiry`, `ledger_sequence`, `threshold`, `revoked`.

Notes:
- The GraphQL layer reuses the same DB adapter (`queryClaims`) so filters are
  executed by the database and are consistent with the REST views.
- Pagination uses offset-style `limit` / `offset` which is simple and
  predictable for integrators. The `/recent` REST endpoint preserves
  keyset pagination for streaming recent claims.

Examples:

Fetch all active `kyc` claims from a given issuer:

```graphql
query {
  claims(credential_type: "kyc", issuer: "GISSUER", active: true, limit: 50) {
    total
    claims { wallet verified_at expiry }
  }
}
```

Fetch a single wallet's claims:

```graphql
query($w:String){ claims(wallet:$w){ claims { credential_type issuer revoked } } }
```
