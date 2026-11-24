-- ============================================================================
-- StellarCred Multi-Tenant Issuance Configuration Migration
-- File: db/migrations/tenant_config.sql
-- ============================================================================

-- Ensure uuid-ossp or pgcrypto extension exists for UUID generation
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ----------------------------------------------------------------------------
-- 1. Tenants Table
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tenants (
    id VARCHAR(64) PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    -- Secure hash of the tenant API key (SHA-256 / argon2 / pgcrypto)
    -- Plaintext API keys are never stored in the database.
    api_key_hash VARCHAR(128) NOT NULL UNIQUE,
    status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'revoked')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ----------------------------------------------------------------------------
-- 2. Tenant Issuer Configurations Table
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tenant_issuer_configs (
    tenant_id VARCHAR(64) PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
    -- Stellar address for the tenant's on-chain registered issuer account
    issuer_id VARCHAR(56) NOT NULL,
    issuer_name VARCHAR(255) NOT NULL,
    -- Reference path in Vault (e.g. "secret/data/stellarcred/tenants/org_acme/signing-key")
    -- Plaintext private keys must NEVER be stored in the database!
    signing_key_secret_ref VARCHAR(512) NOT NULL,
    -- Array of credential types permitted for issuance (e.g. ['kyc', 'age', 'income'])
    allowed_credential_types TEXT[] NOT NULL DEFAULT ARRAY['kyc', 'age'],
    -- JSONB template customizations, claims thresholds, or metadata
    templates JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ----------------------------------------------------------------------------
-- 3. Indexes for High-Performance Tenant Resolution
-- ----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_tenants_api_key_hash ON tenants(api_key_hash);
CREATE INDEX IF NOT EXISTS idx_tenants_status ON tenants(status);
CREATE INDEX IF NOT EXISTS idx_tenant_issuer_configs_issuer_id ON tenant_issuer_configs(issuer_id);

-- ----------------------------------------------------------------------------
-- 4. PostgreSQL Row Level Security (RLS) for Tenant Isolation
-- ----------------------------------------------------------------------------
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_issuer_configs ENABLE ROW LEVEL SECURITY;

-- Tenant Isolation Policy on tenants table
DROP POLICY IF EXISTS tenant_isolation_tenants_policy ON tenants;
CREATE POLICY tenant_isolation_tenants_policy ON tenants
    FOR ALL
    USING (
        id = current_setting('app.current_tenant_id', true)
        OR current_setting('app.is_super_admin', true) = 'true'
    );

-- Tenant Isolation Policy on tenant_issuer_configs table
DROP POLICY IF EXISTS tenant_isolation_configs_policy ON tenant_issuer_configs;
CREATE POLICY tenant_isolation_configs_policy ON tenant_issuer_configs
    FOR ALL
    USING (
        tenant_id = current_setting('app.current_tenant_id', true)
        OR current_setting('app.is_super_admin', true) = 'true'
    );

-- ----------------------------------------------------------------------------
-- 5. Automatic Timestamp Trigger
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_tenants_updated_at ON tenants;
CREATE TRIGGER trigger_tenants_updated_at
    BEFORE UPDATE ON tenants
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS trigger_tenant_issuer_configs_updated_at ON tenant_issuer_configs;
CREATE TRIGGER trigger_tenant_issuer_configs_updated_at
    BEFORE UPDATE ON tenant_issuer_configs
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- ============================================================================
-- Comments
-- ============================================================================
COMMENT ON TABLE tenants IS 'Stores tenant identity and status for multi-tenant credential issuance.';
COMMENT ON TABLE tenant_issuer_configs IS 'Issuer credentials and permitted credential types mapped per tenant with HashiCorp Vault references.';
