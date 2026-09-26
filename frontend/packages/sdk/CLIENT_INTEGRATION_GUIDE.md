# @stellarcred/sdk Client Integration Guide

## Overview

This guide explains how to integrate the StellarCred SDK into your application to verify zero-knowledge credentials on Stellar.

The SDK provides:
- **ProofRegistry client**: Query verified credentials
- **IssuerRegistry client**: Enumerate trusted issuers
- **CredentialVerifier client**: Check VK versions
- **Type definitions**: TypeScript types for all contract interactions

---

## Installation

### Prerequisites

- Node.js 16+
- `@stellar/stellar-sdk` 13.0.0+

### Install via npm

```bash
npm install @stellarcred/sdk
```

### Install via yarn

```bash
yarn add @stellarcred/sdk
```

---

## Quick Start

### 1. Query a Verified Credential

```typescript
import { ProofRegistry } from "@stellarcred/sdk";
import { Keypair, networks, rpcUrl } from "@stellar/stellar-sdk";
import SorobanClient from "stellar-sdk/lib/soroban";

// Connect to Soroban RPC
const rpc = new SorobanClient.Server(rpcUrl(networks.TESTNET_PASSPHRASE));

// Initialize the registry client
const registryId = "CA...";  // From deployment
const registry = new ProofRegistry(registryId, rpc);

// Check if holder has a verified KYC credential
const holder = "G...";  // Holder's Stellar address
const verified = await registry.check_claim(
  holder,
  "kyc",           // credential type
  undefined,       // no min threshold
  undefined        // check all issuers
);

console.log(`KYC verified: ${verified}`);
```

### 2. Query Trusted Issuers

```typescript
import { IssuerRegistry } from "@stellarcred/sdk";

const issuerRegistryId = "CA...";  // From deployment
const issuerRegistry = new IssuerRegistry(issuerRegistryId, rpc);

// Get all registered issuers (paginated)
const issuers = await issuerRegistry.get_issuers_page(0, 10);

for (const issuer of issuers) {
  console.log(`Issuer: ${issuer}`);
}
```

### 3. Access Contract Versions

```typescript
import { ProofRegistry, CredentialVerifier } from "@stellarcred/sdk";

const registry = new ProofRegistry(registryId, rpc);
const verifier = new CredentialVerifier(verifierId, rpc);

// Query contract versions (SDK 0.2.0+)
const registryVersion = await registry.version();
const verifierVersion = await verifier.version();

console.log(`Registry: v${decodeVersion(registryVersion)}`);
console.log(`Verifier: v${decodeVersion(verifierVersion)}`);

function decodeVersion(versionU32: number): string {
  const major = Math.floor(versionU32 / 1_000_000);
  const minor = Math.floor((versionU32 % 1_000_000) / 1_000);
  const patch = versionU32 % 1_000;
  return `${major}.${minor}.${patch}`;
}
```

---

## Type Definitions

### ProofRecord

Represents a cached, verified credential:

```typescript
interface ProofRecord {
  verified_at: u64;      // Ledger timestamp of verification
  expiry: u64;           // When credential expires
  threshold?: u64;       // For range credentials (e.g., age, income)
  revoked: boolean;      // Whether credential was revoked
  issuer?: Address;      // Address of issuing entity
  vk_version: u32;       // Which VK version verified this
}
```

### Issuer

Represents a trusted issuer:

```typescript
interface Issuer {
  pubkey: BytesN<64>;              // secp256k1 public key (x || y)
  credential_types: Symbol[];      // Types this issuer can attest
  revoked: boolean;                // Whether issuer was revoked
}
```

---

## Common Usage Patterns

### Pattern 1: Gate a Transaction

Only allow transfers if holder has valid credential:

```typescript
async function gateTransfer(holder: string, amount: number) {
  const registry = new ProofRegistry(registryId, rpc);

  // Check if holder has valid KYC
  const kyc_verified = await registry.check_claim(holder, "kyc");

  if (!kyc_verified) {
    throw new Error("Holder must complete KYC");
  }

  // Proceed with transfer
  return transferFunds(holder, amount);
}
```

### Pattern 2: Display Credential Status

Show user their verified credentials in the UI:

```typescript
async function getUserCredentials(holder: string) {
  const registry = new ProofRegistry(registryId, rpc);
  const credentialTypes = ["kyc", "age", "income", "accreditation"];

  const credentials = {};

  for (const type of credentialTypes) {
    try {
      const verified = await registry.check_claim(holder, type);
      credentials[type] = verified ? "verified" : "not_verified";
    } catch (e) {
      credentials[type] = "error";
    }
  }

  return credentials;
}
```

### Pattern 3: Check Issuer Authority

Verify that an issuer is trusted for a specific credential:

```typescript
async function isIssuerTrusted(
  issuer: string,
  credentialType: string
): Promise<boolean> {
  const issuerRegistry = new IssuerRegistry(issuerRegistryId, rpc);

  try {
    // Get issuer details
    const issuerData = await issuerRegistry.get_issuer(issuer);

    // Check if issuer supports this credential type
    return issuerData.credential_types.includes(credentialType);
  } catch (e) {
    return false; // Issuer not found
  }
}
```

### Pattern 4: Monitor for Revocations

Check if previously verified credentials are still valid:

```typescript
async function monitorCredentialStatus(holder: string, credentialType: string) {
  const registry = new ProofRegistry(registryId, rpc);

  // Poll every 10 seconds for 1 minute
  for (let i = 0; i < 6; i++) {
    const verified = await registry.check_claim(holder, credentialType);

    if (!verified) {
      console.warn(`Credential revoked: ${credentialType}`);
      return { revoked: true, checksAt: new Date() };
    }

    await new Promise((resolve) => setTimeout(resolve, 10_000));
  }

  return { revoked: false, checksAt: new Date() };
}
```

---

## Error Handling

### Common Errors

```typescript
import { ProofRegistry } from "@stellarcred/sdk";

async function safeCheckClaim(holder: string, type: string) {
  const registry = new ProofRegistry(registryId, rpc);

  try {
    return await registry.check_claim(holder, type);
  } catch (error) {
    if (error.message.includes("ProofNotFound")) {
      return false; // Not verified
    } else if (error.message.includes("NotInitialized")) {
      throw new Error("Contracts not properly initialized");
    } else if (error.message.includes("IssuerNotTrusted")) {
      throw new Error("Issuer not recognized");
    } else {
      throw error; // Unknown error
    }
  }
}
```

### Network Errors

```typescript
async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries: number = 3
): Promise<T> {
  let lastError;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      if (attempt < maxRetries) {
        // Exponential backoff: 1s, 2s, 4s
        await new Promise((resolve) =>
          setTimeout(resolve, Math.pow(2, attempt - 1) * 1000)
        );
      }
    }
  }

  throw lastError;
}

// Usage
const verified = await withRetry(() =>
  registry.check_claim(holder, "kyc")
);
```

---

## Advanced Usage

### Using Custom RPC Endpoints

```typescript
import SorobanClient from "stellar-sdk/lib/soroban";

// Use custom RPC (e.g., for private networks)
const customRpc = new SorobanClient.Server("https://your-soroban-rpc.example.com");

const registry = new ProofRegistry(registryId, customRpc);
```

### Batch Credential Checks

```typescript
async function checkBatchCredentials(
  holders: string[],
  credentialTypes: string[]
): Promise<Record<string, Record<string, boolean>>> {
  const registry = new ProofRegistry(registryId, rpc);
  const results: Record<string, Record<string, boolean>> = {};

  // Run all checks in parallel
  const promises = holders.flatMap((holder) =>
    credentialTypes.map(async (type) => {
      const verified = await registry.check_claim(holder, type);
      if (!results[holder]) results[holder] = {};
      results[holder][type] = verified;
    })
  );

  await Promise.all(promises);
  return results;
}
```

### Listen to Contract Events (SDK 0.2.0+)

```typescript
// Monitor for upgraded contracts
async function watchForUpgrades(contractId: string) {
  // Subscribe to EventContractUpgraded
  // When detected, refresh version information
  registry.on("upgraded", (event) => {
    console.log(`Contract upgraded: ${event.new_wasm_hash}`);
    refreshVersionInfo();
  });
}
```

---

## Version Compatibility

This SDK version supports contracts:

| Component | Min Version | Max Version |
|-----------|-------------|------------|
| ProofRegistry | 1.0.0 | 1.x |
| CredentialVerifier | 1.0.0 | 1.x |
| IssuerRegistry | 1.0.0 | 1.x |
| GatedPool | 1.0.0 | 1.x |

**Upgrade guide:** See `VERSION_COMPATIBILITY.md` in the main repository.

---

## Performance Considerations

### Caching Query Results

```typescript
// Cache credential verification for 1 minute
const credentialCache = new Map<string, { verified: boolean; expiry: number }>();

async function checkClaimCached(
  holder: string,
  credentialType: string,
  ttl: number = 60_000
): Promise<boolean> {
  const cacheKey = `${holder}:${credentialType}`;
  const cached = credentialCache.get(cacheKey);

  if (cached && cached.expiry > Date.now()) {
    return cached.verified;
  }

  const verified = await registry.check_claim(holder, credentialType);

  credentialCache.set(cacheKey, {
    verified,
    expiry: Date.now() + ttl,
  });

  return verified;
}
```

### Parallel Queries

```typescript
// Query multiple credentials in parallel
async function getAllCredentials(holder: string) {
  const types = ["kyc", "age", "income"];

  const results = await Promise.allSettled(
    types.map((type) => registry.check_claim(holder, type))
  );

  return types.reduce((acc, type, i) => {
    const result = results[i];
    acc[type] =
      result.status === "fulfilled" ? result.value : false;
    return acc;
  }, {});
}
```

---

## Testing

### Mock Contract for Testing

```typescript
// Mock ProofRegistry for unit tests
class MockProofRegistry {
  private verified = new Map<string, Set<string>>();

  async check_claim(
    holder: string,
    credentialType: string
  ): Promise<boolean> {
    return this.verified.get(holder)?.has(credentialType) ?? false;
  }

  setVerified(holder: string, credentialType: string, verified: boolean) {
    if (!this.verified.has(holder)) {
      this.verified.set(holder, new Set());
    }
    if (verified) {
      this.verified.get(holder)!.add(credentialType);
    } else {
      this.verified.get(holder)!.delete(credentialType);
    }
  }
}

// Usage in tests
const mockRegistry = new MockProofRegistry();
mockRegistry.setVerified("G...", "kyc", true);

expect(await mockRegistry.check_claim("G...", "kyc")).toBe(true);
```

---

## Troubleshooting

### "Contract not found"

**Cause:** Contract ID is invalid or not deployed

**Solution:**
```typescript
// Verify contract is deployed
const info = await rpc.getContractData(registryId, /* ... */);
console.log(info); // Should return contract info
```

### "Network error" or "RPC timeout"

**Cause:** RPC endpoint is unavailable

**Solution:**
```typescript
// Use with retry logic
const registry = new ProofRegistry(registryId, rpc);
const verified = await withRetry(() => 
  registry.check_claim(holder, "kyc"), 
  3  // Retry up to 3 times
);
```

### "Type mismatch" errors

**Cause:** SDK version doesn't match contract version

**Solution:**
```bash
# Update SDK to latest version
npm install @stellarcred/sdk@latest

# Check version compatibility
npm list @stellarcred/sdk
# Should show 0.2.0+ for newer contracts
```

---

## API Reference

### ProofRegistry

```typescript
class ProofRegistry {
  // Check if holder has verified credential
  check_claim(
    holder: Address,
    credential_type: Symbol,
    min_threshold?: u64,
    trusted_issuers?: Address[]
  ): Promise<boolean>

  // Pause submissions (admin only)
  pause(): Promise<void>

  // Resume submissions (admin only)
  unpause(): Promise<void>

  // Get contract version (SDK 0.2.0+)
  version(): Promise<u32>

  // Get admin address
  admin(): Promise<Address>
}
```

### IssuerRegistry

```typescript
class IssuerRegistry {
  // Get all registered issuers
  get_issuers(): Promise<Address[]>

  // Get paginated issuer list
  get_issuers_page(start: u32, limit: u32): Promise<Address[]>

  // Get issuer details
  get_issuer(issuer_id: Address): Promise<Issuer>

  // Get issuer metadata (SDK 0.2.0+)
  get_issuer_metadata(issuer_id: Address): Promise<IssuerMetadata>

  // Total issuer count
  issuer_count(): Promise<u32>

  // Get contract version (SDK 0.2.0+)
  version(): Promise<u32>
}
```

### CredentialVerifier

```typescript
class CredentialVerifier {
  // Verify UltraHonk proof
  verify_proof(
    credential_type: Symbol,
    proof: Bytes,
    public_inputs: Bytes,
    vk_version?: u32
  ): Promise<boolean>

  // Get latest VK version for credential type
  get_latest_version(credential_type: Symbol): Promise<u32>

  // Get contract version (SDK 0.2.0+)
  version(): Promise<u32>
}
```

---

## Support

For issues or questions:

1. **Check this guide** for common patterns
2. **Review API reference** for method signatures
3. **Check VERSION_COMPATIBILITY.md** for version mismatches
4. **Open GitHub issue** with:
   - SDK version
   - Contract versions
   - Error message
   - Minimal reproduction code

---

## Changelog

### v0.1.1 (Current)

- Initial release
- ProofRegistry client
- IssuerRegistry client
- TypeScript types

### v0.2.0 (Planned)

- Add version() queries
- Support EventContractUpgraded
- Migration endpoints
- Event subscriptions

