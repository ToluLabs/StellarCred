//! Pre-flight witness and public-input validation routines for `no_std` Soroban
//! contracts.
//!
//! Validates proof byte length, 32-byte field alignment, BN254 scalar field
//! bounds, integer bit-width bounds (`u8`, `u64`, `bool`), and array dimensions
//! before invoking the UltraHonk verifier or downstream circuit consumers.

use soroban_sdk::Bytes;
use ultrahonk_soroban_verifier::PROOF_BYTES;

/// Byte length of one big-endian BN254 scalar field element.
pub const FIELD_BYTES: usize = 32;

/// BN254 scalar field modulus `r` in big-endian bytes:
/// `21888242871839275222246405745257275088548364400416034343698204186575808495617`
/// (`0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001`).
pub const BN254_FR_MODULUS: [u8; FIELD_BYTES] = [
    0x30, 0x64, 0x4e, 0x72, 0xe1, 0x31, 0xa0, 0x29, 0xb8, 0x50, 0x45, 0xb6, 0x81, 0x81, 0x58, 0x5d,
    0x28, 0x33, 0xe8, 0x48, 0x79, 0xb9, 0x70, 0x91, 0x43, 0xe1, 0xf5, 0x93, 0xf0, 0x00, 0x00, 0x01,
];

/// Structured error returned when pre-flight witness or public-input validation fails.
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum WitnessValidationError {
    /// Proof byte length does not match `PROOF_BYTES`.
    InvalidProofLength,
    /// Public-inputs byte length is not a multiple of `FIELD_BYTES` (32).
    UnalignedPublicInputs,
    /// The 32-byte field element at the given index is `>= BN254_FR_MODULUS`.
    FieldOutOfBounds(u32),
    /// An array or slice did not match its expected fixed dimension.
    InvalidArrayDimension { expected: u32, actual: u32 },
    /// A field element exceeded the unsigned bit-width expected by the circuit.
    ValueOutOfBounds { bit_width: u16 },
    /// A boolean field element was neither `0` nor `1`.
    InvalidBoolean,
}

/// Returns `true` iff `bytes` (big-endian) is strictly less than `BN254_FR_MODULUS`.
#[inline]
pub fn is_valid_bn254_field(bytes: &[u8; FIELD_BYTES]) -> bool {
    // Big-endian lexicographical comparison is exact for unsigned 256-bit integers.
    bytes < &BN254_FR_MODULUS
}

/// Validates that a byte slice has length `FIELD_BYTES` and is `< BN254_FR_MODULUS`.
pub fn validate_field_slice(bytes: &[u8]) -> Result<[u8; FIELD_BYTES], WitnessValidationError> {
    if bytes.len() != FIELD_BYTES {
        return Err(WitnessValidationError::InvalidArrayDimension {
            expected: FIELD_BYTES as u32,
            actual: bytes.len() as u32,
        });
    }
    let mut buf = [0u8; FIELD_BYTES];
    buf.copy_from_slice(bytes);
    if !is_valid_bn254_field(&buf) {
        return Err(WitnessValidationError::FieldOutOfBounds(0));
    }
    Ok(buf)
}

/// Validates that a big-endian 32-byte field element fits in `u64` (top 24 bytes zero).
pub fn validate_u64_field(bytes: &[u8; FIELD_BYTES]) -> Result<u64, WitnessValidationError> {
    if bytes[..24].iter().any(|&b| b != 0) {
        return Err(WitnessValidationError::ValueOutOfBounds { bit_width: 64 });
    }
    let mut low = [0u8; 8];
    low.copy_from_slice(&bytes[24..32]);
    Ok(u64::from_be_bytes(low))
}

/// Validates that a big-endian 32-byte field element fits in `u8` (top 31 bytes zero).
pub fn validate_u8_field(bytes: &[u8; FIELD_BYTES]) -> Result<u8, WitnessValidationError> {
    if bytes[..31].iter().any(|&b| b != 0) {
        return Err(WitnessValidationError::ValueOutOfBounds { bit_width: 8 });
    }
    Ok(bytes[31])
}

/// Validates that a big-endian 32-byte field element encodes a boolean (`0` or `1`).
pub fn validate_bool_field(bytes: &[u8; FIELD_BYTES]) -> Result<bool, WitnessValidationError> {
    if bytes[..31].iter().any(|&b| b != 0) {
        return Err(WitnessValidationError::InvalidBoolean);
    }
    match bytes[31] {
        0 => Ok(false),
        1 => Ok(true),
        _ => Err(WitnessValidationError::InvalidBoolean),
    }
}

/// Validates that an array dimension matches `expected`.
#[inline]
pub fn validate_array_dimension(actual: u32, expected: u32) -> Result<(), WitnessValidationError> {
    if actual != expected {
        return Err(WitnessValidationError::InvalidArrayDimension { expected, actual });
    }
    Ok(())
}

/// Validates that `public_inputs` is 32-byte aligned and every 32-byte big-endian
/// element is strictly below `BN254_FR_MODULUS`. Returns the number of field elements.
pub fn validate_public_inputs(public_inputs: &Bytes) -> Result<u32, WitnessValidationError> {
    let total_len = public_inputs.len() as usize;
    if total_len % FIELD_BYTES != 0 {
        return Err(WitnessValidationError::UnalignedPublicInputs);
    }
    let field_count = (total_len / FIELD_BYTES) as u32;
    let mut chunk = [0u8; FIELD_BYTES];
    for i in 0..field_count {
        let start = i * (FIELD_BYTES as u32);
        public_inputs
            .slice(start..start + (FIELD_BYTES as u32))
            .copy_into_slice(&mut chunk);
        if !is_valid_bn254_field(&chunk) {
            return Err(WitnessValidationError::FieldOutOfBounds(i));
        }
    }
    Ok(field_count)
}

/// Pre-flight validation for `CredentialVerifier::verify_proof`: checks proof length,
/// public-input 32-byte alignment, and BN254 scalar field bounds.
pub fn validate_proof_and_public_inputs(
    proof: &Bytes,
    public_inputs: &Bytes,
) -> Result<u32, WitnessValidationError> {
    if proof.len() as usize != PROOF_BYTES {
        return Err(WitnessValidationError::InvalidProofLength);
    }
    validate_public_inputs(public_inputs)
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::Env;

    #[test]
    fn bn254_field_bounds_check() {
        assert!(is_valid_bn254_field(&[0u8; FIELD_BYTES]));

        let mut max_valid = BN254_FR_MODULUS;
        max_valid[FIELD_BYTES - 1] -= 1;
        assert!(is_valid_bn254_field(&max_valid));

        assert!(!is_valid_bn254_field(&BN254_FR_MODULUS));
        assert!(!is_valid_bn254_field(&[0xffu8; FIELD_BYTES]));
    }

    #[test]
    fn validate_field_slice_checks_length_and_modulus() {
        assert_eq!(
            validate_field_slice(&[0u8; 31]),
            Err(WitnessValidationError::InvalidArrayDimension {
                expected: 32,
                actual: 31,
            })
        );
        assert_eq!(
            validate_field_slice(&BN254_FR_MODULUS),
            Err(WitnessValidationError::FieldOutOfBounds(0))
        );
        assert!(validate_field_slice(&[0u8; 32]).is_ok());
    }

    #[test]
    fn validate_u64_u8_and_bool_bounds() {
        let mut u64_max = [0u8; FIELD_BYTES];
        u64_max[24..32].copy_from_slice(&u64::MAX.to_be_bytes());
        assert_eq!(validate_u64_field(&u64_max), Ok(u64::MAX));

        let mut u64_overflow = u64_max;
        u64_overflow[23] = 1;
        assert_eq!(
            validate_u64_field(&u64_overflow),
            Err(WitnessValidationError::ValueOutOfBounds { bit_width: 64 })
        );

        let mut u8_max = [0u8; FIELD_BYTES];
        u8_max[31] = 255;
        assert_eq!(validate_u8_field(&u8_max), Ok(255));

        let mut u8_overflow = [0u8; FIELD_BYTES];
        u8_overflow[30] = 1;
        assert_eq!(
            validate_u8_field(&u8_overflow),
            Err(WitnessValidationError::ValueOutOfBounds { bit_width: 8 })
        );

        let mut b_false = [0u8; FIELD_BYTES];
        assert_eq!(validate_bool_field(&b_false), Ok(false));
        b_false[31] = 1;
        assert_eq!(validate_bool_field(&b_false), Ok(true));
        b_false[31] = 2;
        assert_eq!(
            validate_bool_field(&b_false),
            Err(WitnessValidationError::InvalidBoolean)
        );
    }

    #[test]
    fn validate_array_dimension_checks_exact_size() {
        assert_eq!(validate_array_dimension(64, 64), Ok(()));
        assert_eq!(
            validate_array_dimension(63, 64),
            Err(WitnessValidationError::InvalidArrayDimension {
                expected: 64,
                actual: 63,
            })
        );
    }

    #[test]
    fn validate_public_inputs_checks_alignment_and_field_bounds() {
        let env = Env::default();

        // Unaligned public inputs (33 bytes)
        let unaligned = Bytes::from_slice(&env, &[0u8; 33]);
        assert_eq!(
            validate_public_inputs(&unaligned),
            Err(WitnessValidationError::UnalignedPublicInputs)
        );

        // Two valid fields (64 bytes)
        let valid = Bytes::from_slice(&env, &[0u8; 64]);
        assert_eq!(validate_public_inputs(&valid), Ok(2));

        // Second field equals modulus -> FieldOutOfBounds(1)
        let mut bad_bytes = [0u8; 64];
        bad_bytes[32..64].copy_from_slice(&BN254_FR_MODULUS);
        let bad = Bytes::from_slice(&env, &bad_bytes);
        assert_eq!(
            validate_public_inputs(&bad),
            Err(WitnessValidationError::FieldOutOfBounds(1))
        );
    }

    #[test]
    fn validate_proof_and_public_inputs_rejects_short_proof() {
        let env = Env::default();
        let short_proof = Bytes::from_slice(&env, &[0u8; 10]);
        let valid_pi = Bytes::from_slice(&env, &[0u8; 32]);
        assert_eq!(
            validate_proof_and_public_inputs(&short_proof, &valid_pi),
            Err(WitnessValidationError::InvalidProofLength)
        );
    }
}
