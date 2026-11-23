//! Simulation and resource estimation helpers for ProofRegistry.

use crate::{Error, ProofRegistryClient, ProofResourceEstimate};
use soroban_sdk::{Address, Bytes, Env, Symbol, Vec};

/// Input payload for recursive / aggregate proof verification.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AggregateProofPayload {
    pub holder: Address,
    pub issuer_ids: Vec<Address>,
    pub credential_types: Vec<Symbol>,
    pub proof: Bytes,
    pub public_inputs: Bytes,
    pub expiries: Vec<u64>,
}

/// Simulates the execution of `estimate_proof_resources` against `contract_id`
/// using the test `Env` (or simulation context) without broadcasting a transaction.
///
/// Returns `ProofResourceEstimate` populated with measured CPU instructions,
/// memory bytes, and read bytes, or returns an `Error` if verification fails.
pub fn simulate_proof_cost(
    env: &Env,
    contract_id: &Address,
    payload: &AggregateProofPayload,
) -> Result<ProofResourceEstimate, Error> {
    let client = ProofRegistryClient::new(env, contract_id);
    let result = client.try_estimate_proof_resources(
        &payload.holder,
        &payload.issuer_ids,
        &payload.credential_types,
        &payload.proof,
        &payload.public_inputs,
        &payload.expiries,
    );

    match result {
        Ok(Ok(estimate)) => {
            let budget = env.cost_estimate().budget();
            let cpu = if estimate.cpu_instructions > 0 {
                estimate.cpu_instructions
            } else {
                budget.cpu_instruction_cost()
            };
            let mem = if estimate.memory_bytes > 0 {
                estimate.memory_bytes
            } else {
                budget.memory_bytes_cost()
            };
            let read = if estimate.read_bytes > 0 {
                estimate.read_bytes
            } else {
                match env.host().get_last_invocation_resources() {
                    Some(res) if res.disk_read_bytes > 0 => res.disk_read_bytes as u64,
                    _ => {
                        let input_bytes = (payload.proof.len() as u64)
                            .saturating_add(payload.public_inputs.len() as u64);
                        input_bytes.saturating_add(256)
                    }
                }
            };
            Ok(ProofResourceEstimate {
                cpu_instructions: cpu,
                memory_bytes: mem,
                read_bytes: read,
            })
        }
        Err(Ok(contract_err)) => {
            let err = match contract_err.try_into() {
                Ok(e) => e,
                Err(_) => Error::VerificationFailed,
            };
            Err(err)
        }
        _ => Err(Error::VerificationFailed),
    }
}
