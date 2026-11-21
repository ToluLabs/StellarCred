import { StrKey } from '@stellar/stellar-sdk';

/**
 * Convert an Ed25519 public key to Stellar's canonical address encoding.
 * Validation and re-encoding make casing and equivalent input representations
 * consistent before an address is serialized into an SDK request.
 */
export function normalizeStellarAddress(address: string): string {
  const value = address.trim();
  if (!value) {
    throw new Error('Stellar address is required');
  }

  try {
    return StrKey.encodeEd25519PublicKey(StrKey.decodeEd25519PublicKey(value));
  } catch {
    throw new Error('Invalid Stellar address');
  }
}