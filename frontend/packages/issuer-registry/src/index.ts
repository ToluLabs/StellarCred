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
    contractId: "CB246P3C2HBJVK7U5B5JLOLBCG6E73OXVXTXGR46X3IYC5EO64YFYAKC",
  }
} as const

export const Errors = {
  1: {message:"NotInitialized"},
  2: {message:"IssuerNotFound"}
}


export interface Issuer {
  /**
 * Credential types this issuer is trusted to attest.
 */
credential_types: Array<string>;
  /**
 * secp256k1 public key (x || y, 32 bytes each) the issuer signs credentials
 * with. A proof carries this key as a public input; ProofRegistry checks it
 * matches this registered value, so a proof can only pass if a registered
 * issuer actually signed the credential commitment.
 */
pubkey: Buffer;
  revoked: boolean;
}

export type DataKey = {tag: "Admin", values: void} | {tag: "Issuer", values: readonly [string]};

export interface Client {
  /**
   * Construct and simulate a admin transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  admin: (options?: MethodOptions) => Promise<AssembledTransaction<string>>

  /**
   * Construct and simulate a revoke_issuer transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Mark an issuer as revoked. Admin-only. Existing proofs are not affected
   * here — revocation propagates through `is_valid_issuer` checks.
   */
  revoke_issuer: ({issuer_id}: {issuer_id: string}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a is_valid_issuer transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * True iff `issuer_id` is registered, not revoked, and trusted for
   * `credential_type`.
   */
  is_valid_issuer: ({issuer_id, credential_type}: {issuer_id: string, credential_type: string}, options?: MethodOptions) => Promise<AssembledTransaction<boolean>>

  /**
   * Construct and simulate a register_issuer transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Register (or overwrite) a trusted issuer. Admin-only.
   */
  register_issuer: ({issuer_id, pubkey, credential_types}: {issuer_id: string, pubkey: Buffer, credential_types: Array<string>}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a get_issuer_pubkey transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Look up an issuer's credential-signing public key (secp256k1 x || y).
   */
  get_issuer_pubkey: ({issuer_id}: {issuer_id: string}, options?: MethodOptions) => Promise<AssembledTransaction<Buffer>>

}
export class Client extends ContractClient {
  static async deploy<T = Client>(
        /** Constructor/Initialization Args for the contract's `__constructor` method */
        {admin}: {admin: string},
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
    return ContractClient.deploy({admin}, options)
  }
  constructor(public readonly options: ContractClientOptions) {
    super(
      new ContractSpec([ "AAAABAAAAAAAAAAAAAAABUVycm9yAAAAAAAAAgAAAAAAAAAOTm90SW5pdGlhbGl6ZWQAAAAAAAEAAAAAAAAADklzc3Vlck5vdEZvdW5kAAAAAAAC",
        "AAAAAQAAAAAAAAAAAAAABklzc3VlcgAAAAAAAwAAADJDcmVkZW50aWFsIHR5cGVzIHRoaXMgaXNzdWVyIGlzIHRydXN0ZWQgdG8gYXR0ZXN0LgAAAAAAEGNyZWRlbnRpYWxfdHlwZXMAAAPqAAAAEQAAAQ1zZWNwMjU2azEgcHVibGljIGtleSAoeCB8fCB5LCAzMiBieXRlcyBlYWNoKSB0aGUgaXNzdWVyIHNpZ25zIGNyZWRlbnRpYWxzCndpdGguIEEgcHJvb2YgY2FycmllcyB0aGlzIGtleSBhcyBhIHB1YmxpYyBpbnB1dDsgUHJvb2ZSZWdpc3RyeSBjaGVja3MgaXQKbWF0Y2hlcyB0aGlzIHJlZ2lzdGVyZWQgdmFsdWUsIHNvIGEgcHJvb2YgY2FuIG9ubHkgcGFzcyBpZiBhIHJlZ2lzdGVyZWQKaXNzdWVyIGFjdHVhbGx5IHNpZ25lZCB0aGUgY3JlZGVudGlhbCBjb21taXRtZW50LgAAAAAAAAZwdWJrZXkAAAAAA+4AAABAAAAAAAAAAAdyZXZva2VkAAAAAAE=",
        "AAAAAgAAAAAAAAAAAAAAB0RhdGFLZXkAAAAAAgAAAAAAAAAAAAAABUFkbWluAAAAAAAAAQAAAAAAAAAGSXNzdWVyAAAAAAABAAAAEw==",
        "AAAAAAAAAAAAAAAFYWRtaW4AAAAAAAAAAAAAAQAAABM=",
        "AAAAAAAAACxTZXQgdGhlIHByb3RvY29sIGFkbWluIG9uY2UsIGF0IGRlcGxveSB0aW1lLgAAAA1fX2NvbnN0cnVjdG9yAAAAAAAAAQAAAAAAAAAFYWRtaW4AAAAAAAATAAAAAA==",
        "AAAAAAAAAIhNYXJrIGFuIGlzc3VlciBhcyByZXZva2VkLiBBZG1pbi1vbmx5LiBFeGlzdGluZyBwcm9vZnMgYXJlIG5vdCBhZmZlY3RlZApoZXJlIOKAlCByZXZvY2F0aW9uIHByb3BhZ2F0ZXMgdGhyb3VnaCBgaXNfdmFsaWRfaXNzdWVyYCBjaGVja3MuAAAADXJldm9rZV9pc3N1ZXIAAAAAAAABAAAAAAAAAAlpc3N1ZXJfaWQAAAAAAAATAAAAAA==",
        "AAAAAAAAAFNUcnVlIGlmZiBgaXNzdWVyX2lkYCBpcyByZWdpc3RlcmVkLCBub3QgcmV2b2tlZCwgYW5kIHRydXN0ZWQgZm9yCmBjcmVkZW50aWFsX3R5cGVgLgAAAAAPaXNfdmFsaWRfaXNzdWVyAAAAAAIAAAAAAAAACWlzc3Vlcl9pZAAAAAAAABMAAAAAAAAAD2NyZWRlbnRpYWxfdHlwZQAAAAARAAAAAQAAAAE=",
        "AAAAAAAAADVSZWdpc3RlciAob3Igb3ZlcndyaXRlKSBhIHRydXN0ZWQgaXNzdWVyLiBBZG1pbi1vbmx5LgAAAAAAAA9yZWdpc3Rlcl9pc3N1ZXIAAAAAAwAAAAAAAAAJaXNzdWVyX2lkAAAAAAAAEwAAAAAAAAAGcHVia2V5AAAAAAPuAAAAQAAAAAAAAAAQY3JlZGVudGlhbF90eXBlcwAAA+oAAAARAAAAAA==",
        "AAAAAAAAAEVMb29rIHVwIGFuIGlzc3VlcidzIGNyZWRlbnRpYWwtc2lnbmluZyBwdWJsaWMga2V5IChzZWNwMjU2azEgeCB8fCB5KS4AAAAAAAARZ2V0X2lzc3Vlcl9wdWJrZXkAAAAAAAABAAAAAAAAAAlpc3N1ZXJfaWQAAAAAAAATAAAAAQAAA+4AAABA" ]),
      options
    )
  }
  public readonly fromJSON = {
    admin: this.txFromJSON<string>,
        revoke_issuer: this.txFromJSON<null>,
        is_valid_issuer: this.txFromJSON<boolean>,
        register_issuer: this.txFromJSON<null>,
        get_issuer_pubkey: this.txFromJSON<Buffer>
  }
}