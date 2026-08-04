import { Buffer } from "buffer";
import { Address } from "@stellar/stellar-sdk";
import {
  AssembledTransaction,
  Client as ContractClient,
  ClientOptions as ContractClientOptions,
  MethodOptions,
  Result,
  Spec as ContractSpec,
} from "@stellar/stellar-sdk/contract";
import type {
  u32,
  i32,
  u64,
  i64,
  u128,
  i128,
  u256,
  i256,
  Option,
  
  
} from "@stellar/stellar-sdk/contract";
export * from "@stellar/stellar-sdk";
export * as contract from "@stellar/stellar-sdk/contract";
export * as rpc from "@stellar/stellar-sdk/rpc";

if (typeof window !== "undefined") {
  //@ts-ignore Buffer exists
  window.Buffer = window.Buffer || Buffer;
}

export const networks = {
  testnet: {
    networkPassphrase: "Test SDF Network ; September 2015",
    contractId: "CA3I5YDPU4HVJXP7W4HCVIGEZGBSNO4GLUORDMNM4MXX7T23BMWIXQNF",
  }
} as const

export const Errors = {
  1: {message:"NotInitialized"},
  2: {message:"VerificationFailed"},
  3: {message:"NotAuthorized"},
  4: {message:"IssuerNotTrusted"},
  /**
   * The public key the proof was made against does not match the registered
   * issuer's key.
   */
  5: {message:"IssuerKeyMismatch"},
  6: {message:"ProofNotFound"},
  /**
   * The batch contains more than `MAX_BATCH_SIZE` submissions.
   */
  7: {message:"BatchTooLarge"},
  /**
   * The batch must contain at least one submission.
   */
  8: {message:"BatchEmpty"},
  /**
   * Two or more submissions in the batch share the same `credential_type`;
   * only the last write would survive, so the batch is rejected outright.
   */
  9: {message:"DuplicateCredentialType"}
}

export type DataKey = {tag: "Admin", values: void} | {tag: "Verifier", values: void} | {tag: "IssuerRegistry", values: void} | {tag: "Proof", values: readonly [string, string]};


export interface ProofRecord {
  expiry: u64;
  /**
 * The issuer that signed the credential this proof was verified against.
 * Lets a protocol restrict which issuers it trusts per claim type via
 * `trusted_issuers` on `is_verified` / `check_claim`.
 * 
 * `Option` so `issuer` can be explicitly absent within an
 * already-current-shape record (e.g. one written by a future migration
 * that can't recover the original issuer) — `issuer_is_trusted` then
 * fails closed and rejects it under an active `trusted_issuers` filter,
 * since there's no issuer to check against (a filterless caller is
 * unaffected either way). This does NOT, by itself, make a record
 * written before this field existed readable: Soroban's struct decoding
 * requires the stored map's entry count to exactly match the current
 * struct's field count, so those records still fail to deserialize (see
 * `legacy_record_missing_issuer_key_fails_to_read` in test.rs). A real
 * migration is required before redeploying over existing stored proofs.
 */
issuer: Option<string>;
  /**
 * Set by the registered issuer via `revoke`. Expiry data is kept for audit.
 */
revoked: boolean;
  /**
 * For parameterised credential types (age, income, funds), the threshold
 * value that was committed to in the proof's public inputs. None for types
 * with no numeric threshold (kyc, jurisdiction).
 */
threshold: Option<u64>;
  verified_at: u64;
  /**
 * VK version that was used to verify this proof. Preserved so that old
 * proofs remain valid even after the circuit is upgraded to a new version.
 */
vk_version: u32;
}


/**
 * A single proof submission inside a batch. Mirrors the individual parameters
 * of `submit_proof` but grouped into a struct so they can be passed as a `Vec`.
 */
export interface ProofSubmission {
  credential_type: string;
  expiry: u64;
  issuer_id: string;
  proof: Buffer;
  public_inputs: Array<u32>;
  /**
 * VK version to use for verification. `None` defaults to the latest
 * registered version (recommended for new submissions).
 */
vk_version: Option<u32>;
}

export interface Client {
  /**
   * Construct and simulate a admin transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  admin: (options?: MethodOptions) => Promise<AssembledTransaction<string>>

  /**
   * Construct and simulate a revoke transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Invalidate a holder's cached proof. Only the registered issuer for
   * `credential_type` may call this (e.g. when KYC status changes).
   */
  revoke: ({issuer, holder, credential_type}: {issuer: string, holder: string, credential_type: string}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a upgrade transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  upgrade: ({new_wasm_hash}: {new_wasm_hash: Buffer}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a set_admin transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  set_admin: ({new_admin}: {new_admin: string}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a check_claim transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Like `is_verified` but also enforces a minimum threshold for parameterised
   * credential types (age, income, funds). A proof submitted with a threshold
   * of 200_000 satisfies `min_threshold = 50_000` because it proves strictly
   * more. For `kyc` and `jurisdiction`, pass `min_threshold = None`.
   * 
   * `trusted_issuers`, if `Some`, restricts which issuer's proof is accepted
   * — see `is_verified`. `None` accepts any registered issuer (unchanged
   * behaviour).
   */
  check_claim: ({holder, credential_type, min_threshold, trusted_issuers}: {holder: string, credential_type: string, min_threshold: Option<u64>, trusted_issuers: Option<Array<string>>}, options?: MethodOptions) => Promise<AssembledTransaction<boolean>>

  /**
   * Construct and simulate a is_verified transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Returns `(is_currently_valid, verified_at, expiry)`. `is_currently_valid`
   * accounts for expiry against the current ledger time.
   * 
   * `trusted_issuers`, if `Some`, restricts which issuer's proof is accepted:
   * the stored proof's issuer must be in the list, or this returns
   * `(false, verified_at, expiry)` even if the proof is otherwise valid —
   * timestamps are still returned for audit, matching the existing
   * revoked/expired behaviour. `None` accepts any registered issuer
   * (unchanged behaviour).
   */
  is_verified: ({holder, credential_type, trusted_issuers}: {holder: string, credential_type: string, trusted_issuers: Option<Array<string>>}, options?: MethodOptions) => Promise<AssembledTransaction<readonly [boolean, u64, u64]>>

  /**
   * Construct and simulate a revoke_proof transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Revoke a cached proof. The holder authorizes their own revocation.
   */
  revoke_proof: ({holder, credential_type}: {holder: string, credential_type: string}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a submit_proof transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Verify a proof and, if valid, cache it for `holder` until `expiry`
   * (ledger timestamp, seconds). The holder authorizes their own submission.
   * `issuer_id` must be registered and trusted for `credential_type`.
   */
  submit_proof: ({holder, issuer_id, credential_type, proof, public_inputs, vk_version, expiry}: {holder: string, issuer_id: string, credential_type: string, proof: Buffer, public_inputs: Buffer, vk_version: Option<u32>, expiry: u64}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a verifier_address transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  verifier_address: (options?: MethodOptions) => Promise<AssembledTransaction<string>>

  /**
   * Construct and simulate a submit_proofs_batch transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * One event is emitted per successfully verified credential, matching
   * the event emission shape in the single-proof path.
   */
  submit_proofs_batch: ({holder, submissions}: {holder: string, submissions: Array<ProofSubmission>}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a issuer_registry_address transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  issuer_registry_address: (options?: MethodOptions) => Promise<AssembledTransaction<string>>

}
export class Client extends ContractClient {
  static async deploy<T = Client>(
        /** Constructor/Initialization Args for the contract's `__constructor` method */
        {admin, verifier, issuer_registry}: {admin: string, verifier: string, issuer_registry: string},
    /** Options for initializing a Client as well as for calling a method, with extras specific to deploying. */
    options: MethodOptions &
      Omit<ContractClientOptions, "contractId"> & {
        /** The hash of the Wasm blob, which must already be installed on-chain. */
        wasmHash: Buffer | string;
        /** Salt used to generate the contract's ID. Passed through to {@link Operation.createCustomContract}. Default: random. */
        salt?: Buffer | Uint8Array;
        /** The format used to decode `wasmHash`, if it's provided as a string. */
        format?: "hex" | "base64";
      }
  ): Promise<AssembledTransaction<T>> {
    return ContractClient.deploy({admin, verifier, issuer_registry}, options)
  }
  constructor(public readonly options: ContractClientOptions) {
    super(
      new ContractSpec([ "AAAABAAAAAAAAAAAAAAABUVycm9yAAAAAAAACQAAAAAAAAAOTm90SW5pdGlhbGl6ZWQAAAAAAAEAAAAAAAAAElZlcmlmaWNhdGlvbkZhaWxlZAAAAAAAAgAAAAAAAAANTm90QXV0aG9yaXplZAAAAAAAAAMAAAAAAAAAEElzc3Vlck5vdFRydXN0ZWQAAAAEAAAAVVRoZSBwdWJsaWMga2V5IHRoZSBwcm9vZiB3YXMgbWFkZSBhZ2FpbnN0IGRvZXMgbm90IG1hdGNoIHRoZSByZWdpc3RlcmVkCmlzc3VlcidzIGtleS4AAAAAAAARSXNzdWVyS2V5TWlzbWF0Y2gAAAAAAAAFAAAAAAAAAA1Qcm9vZk5vdEZvdW5kAAAAAAAABgAAADpUaGUgYmF0Y2ggY29udGFpbnMgbW9yZSB0aGFuIGBNQVhfQkFUQ0hfU0laRWAgc3VibWlzc2lvbnMuAAAAAAANQmF0Y2hUb29MYXJnZQAAAAAAAAcAAAAvVGhlIGJhdGNoIG11c3QgY29udGFpbiBhdCBsZWFzdCBvbmUgc3VibWlzc2lvbi4AAAAACkJhdGNoRW1wdHkAAAAAAAgAAACMVHdvIG9yIG1vcmUgc3VibWlzc2lvbnMgaW4gdGhlIGJhdGNoIHNoYXJlIHRoZSBzYW1lIGBjcmVkZW50aWFsX3R5cGVgOwpvbmx5IHRoZSBsYXN0IHdyaXRlIHdvdWxkIHN1cnZpdmUsIHNvIHRoZSBiYXRjaCBpcyByZWplY3RlZCBvdXRyaWdodC4AAAAXRHVwbGljYXRlQ3JlZGVudGlhbFR5cGUAAAAACQ==",
        "AAAAAgAAAAAAAAAAAAAAB0RhdGFLZXkAAAAABAAAAAAAAAAAAAAABUFkbWluAAAAAAAAAAAAAAAAAAAIVmVyaWZpZXIAAAAAAAAAAAAAAA5Jc3N1ZXJSZWdpc3RyeQAAAAAAAQAAADhDYWNoZWQgdmVyaWZpY2F0aW9uLCBrZXllZCBieSAoaG9sZGVyLCBjcmVkZW50aWFsX3R5cGUpLgAAAAVQcm9vZgAAAAAAAAIAAAATAAAAEQ==",
        "AAAAAQAAAAAAAAAAAAAAC1Byb29mUmVjb3JkAAAAAAUAAAAAAAAABmV4cGlyeQAAAAAABgAAA6JUaGUgaXNzdWVyIHRoYXQgc2lnbmVkIHRoZSBjcmVkZW50aWFsIHRoaXMgcHJvb2Ygd2FzIHZlcmlmaWVkIGFnYWluc3QuCkxldHMgYSBwcm90b2NvbCByZXN0cmljdCB3aGljaCBpc3N1ZXJzIGl0IHRydXN0cyBwZXIgY2xhaW0gdHlwZSB2aWEKYHRydXN0ZWRfaXNzdWVyc2Agb24gYGlzX3ZlcmlmaWVkYCAvIGBjaGVja19jbGFpbWAuCgpgT3B0aW9uYCBzbyBgaXNzdWVyYCBjYW4gYmUgZXhwbGljaXRseSBhYnNlbnQgd2l0aGluIGFuCmFscmVhZHktY3VycmVudC1zaGFwZSByZWNvcmQgKGUuZy4gb25lIHdyaXR0ZW4gYnkgYSBmdXR1cmUgbWlncmF0aW9uCnRoYXQgY2FuJ3QgcmVjb3ZlciB0aGUgb3JpZ2luYWwgaXNzdWVyKSDigJQgYGlzc3Vlcl9pc190cnVzdGVkYCB0aGVuCmZhaWxzIGNsb3NlZCBhbmQgcmVqZWN0cyBpdCB1bmRlciBhbiBhY3RpdmUgYHRydXN0ZWRfaXNzdWVyc2AgZmlsdGVyLApzaW5jZSB0aGVyZSdzIG5vIGlzc3VlciB0byBjaGVjayBhZ2FpbnN0IChhIGZpbHRlcmxlc3MgY2FsbGVyIGlzCnVuYWZmZWN0ZWQgZWl0aGVyIHdheSkuIFRoaXMgZG9lcyBOT1QsIGJ5IGl0c2VsZiwgbWFrZSBhIHJlY29yZAp3cml0dGVuIGJlZm9yZSB0aGlzIGZpZWxkIGV4aXN0ZWQgcmVhZGFibGU6IFNvcm9iYW4ncyBzdHJ1Y3QgZGVjb2RpbmcKcmVxdWlyZXMgdGhlIHN0b3JlZCBtYXAncyBlbnRyeSBjb3VudCB0byBleGFjdGx5IG1hdGNoIHRoZSBjdXJyZW50CnN0cnVjdCdzIGZpZWxkIGNvdW50LCBzbyB0aG9zZSByZWNvcmRzIHN0aWxsIGZhaWwgdG8gZGVzZXJpYWxpemUgKHNlZQpgbGVnYWN5X3JlY29yZF9taXNzaW5nX2lzc3Vlcl9rZXlfZmFpbHNfdG9fcmVhZGAgaW4gdGVzdC5ycykuIEEgcmVhbAptaWdyYXRpb24gaXMgcmVxdWlyZWQgYmVmb3JlIHJlZGVwbG95aW5nIG92ZXIgZXhpc3Rpbmcgc3RvcmVkIHByb29mcy4AAAAAAAZpc3N1ZXIAAAAAA+gAAAATAAAASVNldCBieSB0aGUgcmVnaXN0ZXJlZCBpc3N1ZXIgdmlhIGByZXZva2VgLiBFeHBpcnkgZGF0YSBpcyBrZXB0IGZvciBhdWRpdC4AAAAAAAAHcmV2b2tlZAAAAAABAAAAvkZvciBwYXJhbWV0ZXJpc2VkIGNyZWRlbnRpYWwgdHlwZXMgKGFnZSwgaW5jb21lLCBmdW5kcyksIHRoZSB0aHJlc2hvbGQKdmFsdWUgdGhhdCB3YXMgY29tbWl0dGVkIHRvIGluIHRoZSBwcm9vZidzIHB1YmxpYyBpbnB1dHMuIE5vbmUgZm9yIHR5cGVzCndpdGggbm8gbnVtZXJpYyB0aHJlc2hvbGQgKGt5YywganVyaXNkaWN0aW9uKS4AAAAAAAl0aHJlc2hvbGQAAAAAAAPoAAAABgAAAAAAAAALdmVyaWZpZWRfYXQAAAAABg==",
        "AAAAAAAAAAAAAAAFYWRtaW4AAAAAAAAAAAAAAQAAABM=",
        "AAAAAAAAAIJJbnZhbGlkYXRlIGEgaG9sZGVyJ3MgY2FjaGVkIHByb29mLiBPbmx5IHRoZSByZWdpc3RlcmVkIGlzc3VlciBmb3IKYGNyZWRlbnRpYWxfdHlwZWAgbWF5IGNhbGwgdGhpcyAoZS5nLiB3aGVuIEtZQyBzdGF0dXMgY2hhbmdlcykuAAAAAAAGcmV2b2tlAAAAAAADAAAAAAAAAAZpc3N1ZXIAAAAAABMAAAAAAAAABmhvbGRlcgAAAAAAEwAAAAAAAAAPY3JlZGVudGlhbF90eXBlAAAAABEAAAAA",
        "AAAAAAAAAAAAAAAHdXBncmFkZQAAAAABAAAAAAAAAA1uZXdfd2FzbV9oYXNoAAAAAAAD7gAAACAAAAAA",
        "AAAAAQAAAJlBIHNpbmdsZSBwcm9vZiBzdWJtaXNzaW9uIGluc2lkZSBhIGJhdGNoLiBNaXJyb3JzIHRoZSBpbmRpdmlkdWFsIHBhcmFtZXRlcnMKb2YgYHN1Ym1pdF9wcm9vZmAgYnV0IGdyb3VwZWQgaW50byBhIHN0cnVjdCBzbyB0aGV5IGNhbiBiZSBwYXNzZWQgYXMgYSBgVmVjYC4AAAAAAAAAAAAAD1Byb29mU3VibWlzc2lvbgAAAAAFAAAAAAAAAA9jcmVkZW50aWFsX3R5cGUAAAAAEQAAAAAAAAAGZXhwaXJ5AAAAAAAGAAAAAAAAAAlpc3N1ZXJfaWQAAAAAAAATAAAAAAAAAAVwcm9vZgAAAAAAAA4AAAAAAAAADXB1YmxpY19pbnB1dHMAAAAAAAPqAAAABA==",
        "AAAAAAAAAAAAAAAJc2V0X2FkbWluAAAAAAAAAQAAAAAAAAAJbmV3X2FkbWluAAAAAAAAEwAAAAA=",
        "AAAAAAAAAbtMaWtlIGBpc192ZXJpZmllZGAgYnV0IGFsc28gZW5mb3JjZXMgYSBtaW5pbXVtIHRocmVzaG9sZCBmb3IgcGFyYW1ldGVyaXNlZApjcmVkZW50aWFsIHR5cGVzIChhZ2UsIGluY29tZSwgZnVuZHMpLiBBIHByb29mIHN1Ym1pdHRlZCB3aXRoIGEgdGhyZXNob2xkCm9mIDIwMF8wMDAgc2F0aXNmaWVzIGBtaW5fdGhyZXNob2xkID0gNTBfMDAwYCBiZWNhdXNlIGl0IHByb3ZlcyBzdHJpY3RseQptb3JlLiBGb3IgYGt5Y2AgYW5kIGBqdXJpc2RpY3Rpb25gLCBwYXNzIGBtaW5fdGhyZXNob2xkID0gTm9uZWAuCgpgdHJ1c3RlZF9pc3N1ZXJzYCwgaWYgYFNvbWVgLCByZXN0cmljdHMgd2hpY2ggaXNzdWVyJ3MgcHJvb2YgaXMgYWNjZXB0ZWQK4oCUIHNlZSBgaXNfdmVyaWZpZWRgLiBgTm9uZWAgYWNjZXB0cyBhbnkgcmVnaXN0ZXJlZCBpc3N1ZXIgKHVuY2hhbmdlZApiZWhhdmlvdXIpLgAAAAALY2hlY2tfY2xhaW0AAAAABAAAAAAAAAAGaG9sZGVyAAAAAAATAAAAAAAAAA9jcmVkZW50aWFsX3R5cGUAAAAAEQAAAAAAAAANbWluX3RocmVzaG9sZAAAAAAAA+gAAAAGAAAAAAAAAA90cnVzdGVkX2lzc3VlcnMAAAAD6AAAA+oAAAATAAAAAQAAAAE=",
        "AAAAAAAAAeZSZXR1cm5zIGAoaXNfY3VycmVudGx5X3ZhbGlkLCB2ZXJpZmllZF9hdCwgZXhwaXJ5KWAuIGBpc19jdXJyZW50bHlfdmFsaWRgCmFjY291bnRzIGZvciBleHBpcnkgYWdhaW5zdCB0aGUgY3VycmVudCBsZWRnZXIgdGltZS4KCmB0cnVzdGVkX2lzc3VlcnNgLCBpZiBgU29tZWAsIHJlc3RyaWN0cyB3aGljaCBpc3N1ZXIncyBwcm9vZiBpcyBhY2NlcHRlZDoKdGhlIHN0b3JlZCBwcm9vZidzIGlzc3VlciBtdXN0IGJlIGluIHRoZSBsaXN0LCBvciB0aGlzIHJldHVybnMKYChmYWxzZSwgdmVyaWZpZWRfYXQsIGV4cGlyeSlgIGV2ZW4gaWYgdGhlIHByb29mIGlzIG90aGVyd2lzZSB2YWxpZCDigJQKdGltZXN0YW1wcyBhcmUgc3RpbGwgcmV0dXJuZWQgZm9yIGF1ZGl0LCBtYXRjaGluZyB0aGUgZXhpc3RpbmcKcmV2b2tlZC9leHBpcmVkIGJlaGF2aW91ci4gYE5vbmVgIGFjY2VwdHMgYW55IHJlZ2lzdGVyZWQgaXNzdWVyCih1bmNoYW5nZWQgYmVoYXZpb3VyKS4AAAAAAAtpc192ZXJpZmllZAAAAAADAAAAAAAAAAZob2xkZXIAAAAAABMAAAAAAAAAD2NyZWRlbnRpYWxfdHlwZQAAAAARAAAAAAAAAA90cnVzdGVkX2lzc3VlcnMAAAAD6AAAA+oAAAATAAAAAQAAA+0AAAADAAAAAQAAAAYAAAAG",
        "AAAAAAAAAEJSZXZva2UgYSBjYWNoZWQgcHJvb2YuIFRoZSBob2xkZXIgYXV0aG9yaXplcyB0aGVpciBvd24gcmV2b2NhdGlvbi4AAAAAAAxyZXZva2VfcHJvb2YAAAACAAAAAAAAAAZob2xkZXIAAAAAABMAAAAAAAAAD2NyZWRlbnRpYWxfdHlwZQAAAAARAAAAAA==",
        "AAAAAAAAAM1WZXJpZnkgYSBwcm9vZiBhbmQsIGlmIHZhbGlkLCBjYWNoZSBpdCBmb3IgYGhvbGRlcmAgdW50aWwgYGV4cGlyeWAKKGxlZGdlciB0aW1lc3RhbXAsIHNlY29uZHMpLiBUaGUgaG9sZGVyIGF1dGhvcml6ZXMgdGhlaXIgb3duIHN1Ym1pc3Npb24uCmBpc3N1ZXJfaWRgIG11c3QgYmUgcmVnaXN0ZXJlZCBhbmQgdHJ1c3RlZCBmb3IgYGNyZWRlbnRpYWxfdHlwZWAuAAAAAAAADHN1Ym1pdF9wcm9vZgAAAAYAAAAAAAAABmhvbGRlcgAAAAAAEwAAAAAAAAAJaXNzdWVyX2lkAAAAAAAAEwAAAAAAAAAPY3JlZGVudGlhbF90eXBlAAAAABEAAAAAAAAABXByb29mAAAAAAAADgAAAAAAAAANcHVibGljX2lucHV0cwAAAAAAAA4AAAAAAAAABmV4cGlyeQAAAAAABgAAAAA=",
        "AAAAAAAAAE5gYWRtaW5gLCBgdmVyaWZpZXJgIGFuZCBgaXNzdWVyX3JlZ2lzdHJ5YCBhcmUgdGhlIGRlcGxveWVkIGNvbnRyYWN0IGFkZHJlc3Nlcy4AAAAAAA1fX2NvbnN0cnVjdG9yAAAAAAAAAwAAAAAAAAAFYWRtaW4AAAAAAAATAAAAAAAAAAh2ZXJpZmllcgAAABMAAAAAAAAAD2lzc3Vlcl9yZWdpc3RyeQAAAAATAAAAAA==",
        "AAAAAAAAAAAAAAAQdmVyaWZpZXJfYWRkcmVzcwAAAAAAAAABAAAAEw==",
        "AAAAAAAAAHZPbmUgZXZlbnQgaXMgZW1pdHRlZCBwZXIgc3VjY2Vzc2Z1bGx5IHZlcmlmaWVkIGNyZWRlbnRpYWwsIG1hdGNoaW5nCnRoZSBldmVudCBlbWlzc2lvbiBzaGFwZSBpbiB0aGUgc2luZ2xlLXByb29mIHBhdGguAAAAAAATc3VibWl0X3Byb29mc19iYXRjaAAAAAACAAAAAAAAAAZob2xkZXIAAAAAABMAAAAAAAAAC3N1Ym1pc3Npb25zAAAAA+oAAAfQAAAAD1Byb29mU3VibWlzc2lvbgAAAAAA",
        "AAAAAAAAAAAAAAAXaXNzdWVyX3JlZ2lzdHJ5X2FkZHJlc3MAAAAAAAAAAAEAAAAT" ]),
      options
    )
  }
  public readonly fromJSON = {
    admin: this.txFromJSON<string>,
        revoke: this.txFromJSON<null>,
        upgrade: this.txFromJSON<null>,
        set_admin: this.txFromJSON<null>,
        check_claim: this.txFromJSON<boolean>,
        is_verified: this.txFromJSON<readonly [boolean, u64, u64]>,
        revoke_proof: this.txFromJSON<null>,
        submit_proof: this.txFromJSON<null>,
        verifier_address: this.txFromJSON<string>,
        submit_proofs_batch: this.txFromJSON<null>,
        issuer_registry_address: this.txFromJSON<string>
  }
}