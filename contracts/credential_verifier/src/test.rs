extern crate std;

use soroban_sdk::{symbol_short, testutils::Address as _, Address, Bytes, Env, Symbol};
use std::format;

use crate::{CredentialVerifier, CredentialVerifierClient};

#[test]
fn test_negative_fixtures_all_circuits() {
    let env = Env::default();
    let admin = Address::generate(&env);
    let contract_id = env.register(CredentialVerifier, (admin,));
    let client = CredentialVerifierClient::new(&env, &contract_id);

    let test_cases = [
        "kyc_wrong_issuer",
        "kyc_truncated_inputs",
        "kyc_wrong_circuit",
        "age_unmet_threshold",
        "income_unmet_threshold",
        "funds_unmet_threshold",
        "range_unmet_threshold",
        "jurisdiction_denylisted",
        "set_membership_wrong_root",
        "aggregate_malformed_layout",
        "employment_invalid_proof",
    ];

    for case in test_cases.iter() {
        let credential_type = match *case {
            "kyc_wrong_issuer" | "kyc_truncated_inputs" | "kyc_wrong_circuit" => {
                symbol_short!("kyc")
            }
            "age_unmet_threshold" => symbol_short!("age"),
            "income_unmet_threshold" => symbol_short!("income"),
            "funds_unmet_threshold" => symbol_short!("funds"),
            "range_unmet_threshold" => symbol_short!("range"),
            "jurisdiction_denylisted" => Symbol::new(&env, "jurisdiction"),
            "set_membership_wrong_root" => Symbol::new(&env, "set_membership"),
            "aggregate_malformed_layout" => Symbol::new(&env, "aggregate"),
            "employment_invalid_proof" => Symbol::new(&env, "employment"),
            _ => unreachable!(),
        };

        // Cargo sets the test working directory to the package root, so the
        // repo-root fixtures must be addressed relative to the manifest dir.
        let base = concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/negative");
        let proof_path = format!("{base}/{case}/proof");
        let vk_path = format!("{base}/{case}/vk");
        let inputs_path = format!("{base}/{case}/public_inputs");

        let proof_bytes = std::fs::read(&proof_path)
            .unwrap_or_else(|_| panic!("Failed to read {}", proof_path));
        let vk_bytes = std::fs::read(&vk_path)
            .unwrap_or_else(|_| panic!("Failed to read {}", vk_path));
        let inputs_bytes = std::fs::read(&inputs_path)
            .unwrap_or_else(|_| panic!("Failed to read {}", inputs_path));

        let proof = Bytes::from_slice(&env, &proof_bytes);
        // Read above to prove the fixture exists; the on-chain verifier resolves
        // the key itself, so the client call does not take it.
        let _vk = Bytes::from_slice(&env, &vk_bytes);
        let public_inputs = Bytes::from_slice(&env, &inputs_bytes);

        let res = client.try_verify_proof(&credential_type, &proof, &public_inputs, &None);
        assert!(res.is_err(), "Expected negative fixture {} to be rejected", case);
    }
}
