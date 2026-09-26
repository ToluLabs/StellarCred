// composite_proof
//
// Evaluates a fixed-shape boolean policy over several committed attributes.
// The policy is a tree of up to 4 terms (leaves) and 3 operators.
// Term types: 0=FALSE, 1=THRESHOLD, 2=MEMBERSHIP, 3=TRUE.
// Ops: 0=AND, 1=OR, 2=LEFT, 3=RIGHT.
//
// Bounding to 4 terms balances flexibility for real-world policies
// (e.g., `(KYC AND (Accredited OR HighIncome)) AND EligibleJurisdiction`)
// with circuit size and proving time, as each term requires evaluating Poseidon and ECDSA.

use dep::credential_lib;
use dep::poseidon::poseidon2::Poseidon2;

global MAX_TERMS: u32 = 4;
global DEPTH: u32 = 8;

fn main(
    values: [u64; 4],
    salts: [Field; 4],
    sigs: [[u8; 64]; 4],
    paths: [[Field; 8]; 4],
    indices: [[u1; 8]; 4],
    
    commitments: pub [Field; 4],
    issuer_xs: pub [[u8; 32]; 4],
    issuer_ys: pub [[u8; 32]; 4],
    
    kinds: pub [u8; 4],
    thresholds: pub [u64; 4],
    merkle_roots: pub [Field; 4],
    
    ops: pub [u8; 3]
) {
    let mut term_results = [false; 4];
    
    for i in 0..4 {
        let kind = kinds[i];
        
        assert(salts[i] != 0);
        credential_lib::assert_committed_and_signed(
            values[i] as Field,
            salts[i],
            sigs[i],
            commitments[i],
            issuer_xs[i],
            issuer_ys[i]
        );
        
        if kind == 1 {
            term_results[i] = values[i] >= thresholds[i];
        } else if kind == 2 {
            let mut current = Poseidon2::hash([values[i] as Field], 1);
            for j in 0..8 {
                let sibling = paths[i][j];
                let index = indices[i][j] as Field;
                let left = index * sibling + (1 - index) * current;
                let right = index * current + (1 - index) * sibling;
                current = Poseidon2::hash([left, right], 2);
            }
            term_results[i] = current == merkle_roots[i];
        } else if kind == 3 {
            term_results[i] = true;
        } else {
            term_results[i] = false;
        }
    }
    
    let mut r0 = false;
    if ops[0] == 0 { r0 = term_results[0] & term_results[1]; }
    else if ops[0] == 1 { r0 = term_results[0] | term_results[1]; }
    else if ops[0] == 2 { r0 = term_results[0]; }
    else if ops[0] == 3 { r0 = term_results[1]; }
    
    let mut r1 = false;
    if ops[1] == 0 { r1 = term_results[2] & term_results[3]; }
    else if ops[1] == 1 { r1 = term_results[2] | term_results[3]; }
    else if ops[1] == 2 { r1 = term_results[2]; }
    else if ops[1] == 3 { r1 = term_results[3]; }
    
    let mut final_res = false;
    if ops[2] == 0 { final_res = r0 & r1; }
    else if ops[2] == 1 { final_res = r0 | r1; }
    else if ops[2] == 2 { final_res = r0; }
    else if ops[2] == 3 { final_res = r1; }
    
    assert(final_res == true);
}

// --- Logic evaluator unit tests ---

fn eval_logic(term_results: [bool; 4], ops: [u8; 3]) -> bool {
    let mut r0 = false;
    if ops[0] == 0 { r0 = term_results[0] & term_results[1]; }
    else if ops[0] == 1 { r0 = term_results[0] | term_results[1]; }
    else if ops[0] == 2 { r0 = term_results[0]; }
    else if ops[0] == 3 { r0 = term_results[1]; }
    
    let mut r1 = false;
    if ops[1] == 0 { r1 = term_results[2] & term_results[3]; }
    else if ops[1] == 1 { r1 = term_results[2] | term_results[3]; }
    else if ops[1] == 2 { r1 = term_results[2]; }
    else if ops[1] == 3 { r1 = term_results[3]; }
    
    let mut final_res = false;
    if ops[2] == 0 { final_res = r0 & r1; }
    else if ops[2] == 1 { final_res = r0 | r1; }
    else if ops[2] == 2 { final_res = r0; }
    else if ops[2] == 3 { final_res = r1; }
    
    final_res
}

#[test]
fn test_pure_and() {
    assert(eval_logic([true, true, true, true], [0, 0, 0]) == true);
    assert(eval_logic([true, false, true, true], [0, 0, 0]) == false);
}

#[test]
fn test_pure_or() {
    assert(eval_logic([false, false, false, false], [1, 1, 1]) == false);
    assert(eval_logic([true, false, false, false], [1, 1, 1]) == true);
    assert(eval_logic([false, false, false, true], [1, 1, 1]) == true);
}

#[test]
fn test_mixed_and_or() {
    // (T0 OR T1) AND (T2 OR T3)
    let ops = [1, 1, 0];
    assert(eval_logic([false, true, true, false], ops) == true);
    assert(eval_logic([false, false, true, false], ops) == false);
    assert(eval_logic([true, false, false, false], ops) == false);
    
    // T0 AND (T2 OR T3) -> T1 ignored (use LEFT for op0)
    let ops2 = [2, 1, 0];
    assert(eval_logic([true, false, true, false], ops2) == true);
    assert(eval_logic([false, true, true, false], ops2) == false);
}

