# HashiCorp Vault Secrets Management for StellarCred

This directory contains configuration, policies, and operational runbooks for integrating HashiCorp Vault as the enterprise secrets manager for StellarCred and its multi-tenant credential issuance engine.

---

## 1. Architecture Overview

StellarCred delegates all sensitive cryptographic key management—including tenant issuer signing keys and system credentials—to HashiCorp Vault.

```
┌──────────────────────────┐             ┌───────────────────────────┐
│     StellarCred API      │             │      HashiCorp Vault      │
│ (Tenant Resolution +     │   HTTPS     │       (KV v2 Engine)      │
│  Issuance Handler)       │────────────▶│                           │
│                          │  X-Vault-   │ secret/data/stellarcred/  │
│  frontend/lib/           │   Token     │   ├── default/issuer-key  │
│  secrets-vault.ts        │             │   └── tenants/<tenant-id>/│
└──────────────────────────┘             └───────────────────────────┘
```

- **Pluggable Secrets Provider:** `frontend/lib/secrets-vault.ts` implements `SecretsProvider`.
- **Zero Plaintext Storage:** Issuer signing keys are never saved in source code or database tables; tenant configurations only store Vault secret paths (`signingKeySecretRef`).
- **Dynamic Caching:** Secrets are cached in-memory with a configurable TTL (default 60 seconds) to balance performance with rotation speed.
- **Fail-Safe Fallback:** In local development or CI where Vault is not deployed, the system gracefully falls back to `EnvSecretsProvider`.

---

## 2. Bootstrapping Vault

### 2.1 Enable the KV v2 Secrets Engine

Enable KV version 2 at the default mount path `secret/`:

```bash
# Enable KV v2 secrets engine
vault secrets enable -version=2 -path=secret kv

# Verify enabled engines
vault secrets list
```

### 2.2 Directory Structure & Secret Schema

Secret paths follow standard hierarchical conventions:

```text
secret/data/stellarcred/
  ├── default/
  │     └── issuer-key                 # Default deployment-wide issuer key
  └── tenants/
        ├── org_acme/
        │     └── signing-key          # Tenant Acme's private signing key
        └── org_bank/
              └── signing-key          # Tenant Bank's private signing key
```

#### Secret Payload Schema

Secrets are stored as JSON key-value pairs:

```json
{
  "privateKey": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "issuerId": "GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ",
  "issuerName": "Acme Identity Authority",
  "algorithm": "secp256k1"
}
```

The provider automatically resolves `.privateKey`, `.signingKey`, or `.value` fields.

---

## 3. Access Control & Least-Privilege Policies

### 3.1 StellarCred App Server Policy (`stellarcred-service.hcl`)

The main service needs read access to tenant signing keys and the default issuer key:

```hcl
# Read default issuer key
path "secret/data/stellarcred/default/*" {
  capabilities = ["read"]
}

# Read tenant signing keys
path "secret/data/stellarcred/tenants/*" {
  capabilities = ["read"]
}

# Health check endpoint
path "sys/health" {
  capabilities = ["read"]
}
```

Apply the policy:

```bash
vault policy write stellarcred-service deployment/vault/policies/stellarcred-service.hcl
```

### 3.2 Tenant Isolation Policy Template

For multi-tenant setups where tenants administer their own keys via Vault AppRole or OIDC tokens:

```hcl
# Restrict tenant administrators strictly to their own path prefix
path "secret/data/stellarcred/tenants/{{identity.entity.metadata.tenant_id}}/*" {
  capabilities = ["create", "read", "update", "delete", "list"]
}

path "secret/metadata/stellarcred/tenants/{{identity.entity.metadata.tenant_id}}/*" {
  capabilities = ["list", "read", "delete"]
}
```

---

## 4. AppRole Authentication Setup

For production deployments, configure AppRole authentication:

```bash
# 1. Enable AppRole auth
vault auth enable approle

# 2. Configure the stellarcred app role
vault write auth/approle/role/stellarcred \
    token_policies="stellarcred-service" \
    token_ttl=1h \
    token_max_ttl=4h \
    secret_id_num_uses=0

# 3. Retrieve Role ID
vault read auth/approle/role/stellarcred/role-id

# 4. Generate Secret ID
vault write -f auth/approle/role/stellarcred/secret-id
```

The service retrieves a token at boot using the role and secret IDs:

```bash
vault write auth/approle/login \
    role_id="$VAULT_ROLE_ID" \
    secret_id="$VAULT_SECRET_ID"
```

---

## 5. Environment Variables Configuration

Set the following environment variables in `.env.local` or container environment:

| Variable | Required | Description | Default |
| :--- | :--- | :--- | :--- |
| `VAULT_ADDR` | Yes | HTTP/HTTPS URL of HashiCorp Vault server | `http://127.0.0.1:8200` |
| `VAULT_TOKEN` | Yes | Authentication token for the service | `""` |
| `VAULT_MOUNT_PATH` | No | KV secrets mount path | `secret` |
| `VAULT_NAMESPACE` | No | Vault Enterprise namespace (optional) | `""` |

---

## 6. Key Rotation Runbook (Zero-Downtime)

When rotating an issuer signing key:

1. **Generate New Keypair:**
   Generate a new 64-character hex secp256k1 key and compute its public key.
2. **Register New Pubkey On-Chain:**
   Submit a transaction to the `IssuerRegistry` Soroban smart contract to register the new public key for the tenant's issuer account.
3. **Write New Version to Vault:**
   Update the secret in Vault KV v2:
   ```bash
   vault kv put secret/stellarcred/tenants/org_acme/signing-key \
       privateKey="<NEW_64_CHAR_HEX_KEY>" \
       issuerId="<TENANT_ISSUER_ADDRESS>"
   ```
4. **Cache Refresh:**
   The in-memory TTL (60s) will automatically expire, loading the new key version seamlessly. For immediate cutover, restart the app pods or trigger cache eviction.
5. **Verification:**
   Verify issuance via `/api/issue` with the tenant's API key.
