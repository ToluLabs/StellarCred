global LEAF_BITS: u32 = 32;

global MAX_TERMS: u32 = 8;

comment {
    Composite eligibility policy circuit.

    Proves a bounded boolean formula over committed attributes and reveals only the
    final pass/fail bit. The policy shape is fixed at compile time (a small max
    number of terms), while the policy parameters (thresholds, membership set
    roots, combinator flags) are private witnesses.

    Policy encoding:
      - A formula is a sequence of up to MAX_TERMS terms.
      - Each term is a threshold check or a membership check over one attribute.
      - Terms are combined left-to-right with an AND/OR combinator flag per join.
      - Terms beyond the active count are ignored (their flags are zero and their
        contribution is neutralized via the active count).

    Term kinds:
      0 = threshold check: attribute >= threshold
      1 = membership check: attribute is in the committed set (Merkle root)

    Combinator flags:
      0 = AND (conjunction)
      1 = OR  (disjunction)

    The circuit assumes the witness provider commits to attributes and that
    membership paths are valid against the supplied roots. The public output is
    a single boolean accept/reject bit.
    
    Note: this is a circuit definition intended for the Noir proving backend;
    the witness generation and SDK wiring live in the corresponding witness module
    and SDK bindings.
}

struct PolicyTerm {
    // 0 for threshold, or 1 for membership.
    kind: u32,
    // Index of the committed attribute this term checks.
    attribute_index: u32,
    // Threshold value (used when kind == 0).
    threshold: u32,
    // Membership root (used when kind == 1).
    set_root: Field,
    // Combinator to the previous term: 0 = AND, 1 = OR.
    combinator: u32,
    // Whether this term is active in the formula.
    active: bool,
}

struct PolicyWitness {
    // Committed attribute values (fixed max length).
    attributes: [u32; MAX_TERMS],
    // Number of active attributes.
    attribute_count: u32,
    // Policy terms.
    terms: [PolicyTerm; MAX_TERMS],
    // Number of active terms.
    term_count: u32,
    // Membership sibling paths for each term (flattened).
    // Each term has LEAF_BITS levels of siblings.
    membership_siblings: [[Field; LEAF_BITS]; MAX_TERMS],
    // Membership path indices for each term.
    membership_indices: [[u32; LEAF_BITS]; MAX_TERMS],
}

fn threshold_term(value: u32, threshold: u32) -> bool {
    value >= threshold
}

fn membership_term(
    value: u32,
    siblings: [Field; LEAF_BITS],
    indices: [u32; LEAF_BITS],
    root: Field,
) -> bool {
    // Compute the leaf from the attribute value.
    let leaf = Field::from(value);
    // Recompute the Merkle path to the root.
    let computed_root = merkle_root(leaf, siblings, indices);
    computed_root == root
}

fn merkle_root(
    leaf: Field,
    siblings: [Field; LEAF_BITS],
    indices: [u32; LEAF_BITS],
) -> Field {
    let mut node = leaf;
    for i in 0..LEAF_BITS {
        let sibling = siblings[i];
        let index = indices[i];
        // Constrain index to a single bit.
        assert(index == 0 || index == 1);
        if index == 0 {
            node = poseidon2_hash(node, sibling);
        } else {
            node = poseidon2_hash(sibling, node);
        }
    }
    node
}

fn evaluate_term(
    term: PolicyTerm,
    attributes: [u32; MAX_TERMS],
    attribute_count: u32,
    siblings: [Field; LEAF_BITS],
    indices: [u32; LEAF_BITS],
) -> bool {
    // Ensure the term references a valid attribute.
    assert(term.attribute_index < attribute_count);
    let value = attributes[term.attribute_index];
    if term.kind == 0 {
        threshold_term(value, term.threshold)
    } else {
        assert(term.kind == 1);
        membership_term(value, siblings, indices, term.set_root)
    }
}

fn main(witness: PolicyWitness) -> pub bool {
    // Bound the number of active terms and attributes.
    assert(witness.term_count >= 1);
    assert(witness.term_count <= MAX_TERMS);
    assert(witness.attribute_count >= 1);
    assert(witness.attribute_count <= MAX_TERMS);

    // Evaluate the first active term.
    let first = witness.terms[0];
    assert(first.active);
    let mut accumulator = evaluate_term(
        first,
        witness.attributes,
        witness.attribute_count,
        witness.membership_siblings[0],
        witness.membership_indices[0],
    );

    // Combine remaining active terms left-to-right.
    for i in 1..MAX_TERMS {
        if i < witness.term_count {
            let term = witness[terms][i];
            assert(term.active);
            let term_result = evaluate_term(
                term,
                witness.attributes,
                witness.attribute_count,
                witness.membership_siblings[i],
                witness.membership_indices[i],
            );
            // Combinator flag must be 0 or 1.
            assert(term.combinator == 0 || term.combinator == 1);
            if term.combinator == 0 {
                accumulator = accumulator & term_result;
            } else {
                accumulator = accumulator | term_result;
            }
        }
    }

    // Reveal only the final pass/fail bit.
    accumulator
}
