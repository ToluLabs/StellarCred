# Negative Test Fixtures

This directory contains negative test fixtures for proof validation. These are well-formed proofs that should be rejected for semantic reasons, as specified in issue #537.

## Fixture Descriptions

### `kyc_wrong_issuer_*`
- **Purpose**: Tests rejection of proofs with a different issuer pubkey in public_inputs
- **Generation**: Modified the valid KYC proof's `public_inputs` to replace `issuer_x` and `issuer_y` with all zeros
- **Expected behavior**: The verifier should reject because the issuer pubkey doesn't match the registered issuer
- **Files**: `proof`, `public_inputs`, `vk`

### `kyc_truncated_inputs_*`
- **Purpose**: Tests rejection of proofs with truncated public_inputs (wrong count)
- **Generation**: Truncated the valid KYC proof's `public_inputs` from 96 bytes to 64 bytes (missing the last 32 bytes for `issuer_y`)
- **Expected behavior**: The verifier should reject due to malformed input length
- **Files**: `proof`, `public_inputs`, `vk`

### `kyc_wrong_circuit_*`
- **Purpose**: Tests rejection of a proof from a different circuit type verified against the wrong VK
- **Generation**: Used the valid age_proof with the kyc VK
- **Expected behavior**: The verifier should reject because the proof structure and public_inputs don't match the VK's expectations
- **Files**: `proof`, `public_inputs`, `vk`

## Regeneration Process

### Prerequisites
- Node.js (for the generation script)
- Valid fixtures in `fixtures/kyc/` and `fixtures/age/`

### Regeneration Steps

1. **Run the generation script**:
   ```bash
   node circuits/scripts/gen_negative_fixtures.js
   ```

2. **Script behavior**:
   - Creates `fixtures/negative/` directory if it doesn't exist
   - Copies and modifies existing valid fixtures to create negative test cases
   - Does NOT require running nargo or bb (uses existing fixtures)

### Manual Regeneration (if needed)

If you need to regenerate these fixtures manually:

1. **Wrong issuer pubkey**:
   ```bash
   # Copy valid KYC fixtures
   cp fixtures/kyc/proof fixtures/negative/kyc_wrong_issuer_proof
   cp fixtures/kyc/vk fixtures/negative/kyc_wrong_issuer_vk
   
   # Modify public_inputs to zero out issuer_x and issuer_y
   # (bytes 32-63 for issuer_x, bytes 64-95 for issuer_y)
   ```

2. **Truncated inputs**:
   ```bash
   # Copy valid KYC fixtures
   cp fixtures/kyc/proof fixtures/negative/kyc_truncated_inputs_proof
   cp fixtures/kyc/vk fixtures/negative/kyc_truncated_inputs_vk
   
   # Truncate public_inputs to 64 bytes (remove issuer_y)
   dd if=fixtures/kyc/public_inputs of=fixtures/negative/kyc_truncated_inputs_public_inputs bs=1 count=64
   ```

3. **Wrong circuit type**:
   ```bash
   # Copy age proof with kyc VK
   cp fixtures/age/proof fixtures/negative/kyc_wrong_circuit_proof
   cp fixtures/age/public_inputs fixtures/negative/kyc_wrong_circuit_public_inputs
   cp fixtures/kyc/vk fixtures/negative/kyc_wrong_circuit_vk
   ```

## Testing

The negative fixtures are tested in:
- `contracts/credential_verifier/src/test.rs` - Verifier tests
- `contracts/proof_registry/src/test.rs` - ProofRegistry tests

Each fixture has corresponding tests that verify it is rejected with the expected error.

## Notes

- These fixtures are intentionally small to avoid bloating the repository
- They focus on semantic validation errors rather than bit-flip mutations
- The generation script is designed to be simple and reproducible
- All fixtures are derived from existing valid fixtures, ensuring consistency
