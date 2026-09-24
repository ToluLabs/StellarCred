// set_membership
//
// Proves a private attribute (e.g. a country code, a role ID, a tier tag)
// belongs to a public allowlist without revealing which member it is.
// Membership is checked via a Merkle inclusion proof against a public root,
// so the set itself never appears on-chain -- only its root does.
//
// Public inputs (in order): commitment, issuer_pub_x, issuer_pub_y, merkle_root
// Private inputs: value, salt, sig, path (sibling hashes), indices (left/right bits)
//
// Trust model:
//   1. The commitment binds the private value to a credential the issuer signed.
//   2. The ECDSA check proves a registered issuer actually attested to that value.
//   3. The Merkle path proves the value (hashed to a leaf) is included in the
//      set whose root the verifier publishes on-chain. A prover who is NOT a
//      member of the set cannot produce a valid Merkle path for any valid leaf.
//
// Tree design:
//   Leaves are computed as   Poseidon2([value], 1)
//   Internal nodes are       Poseidon2([left, right], 2)
//   with left/right ordered by the index bit (0 = value-side is left child,
//   1 = value-side is right child). This is the standard binary Poseidon Merkle
//   tree used by most ZK toolkits; the off-chain helper in
//   circuits/scripts/merkle_tree.js builds it to exactly this spec.
//
// Depth:
//   DEPTH = 8 supports sets of up to 2^8 = 256 members, enough for any country
//   list or tier/role catalogue. Extend DEPTH to 16 or 20 for larger sets; the
//   VK must be regenerated afterwards.

use dep::credential_lib;
use dep::poseidon::poseidon2::Poseidon2;

// Compile-time Merkle depth. Every proof must supply exactly this many sibling
// hashes and index bits. A runtime depth would let the prover shorten the path
// and skip the layers that would reject them.
global DEPTH: u32 = 8;

fn main(
    // --- private inputs ---------------------------------------------------
    // `value` is the set member being proved. Typed u64 (not Field) so it is
    // range-constrained; a raw Field value could be any BN254 scalar.
    value: u64,
    // `salt` makes the commitment hiding. Without it a prover who knows the
    // universe of possible values (e.g. ~250 country codes) could reverse the
    // commitment with a few hundred Poseidon calls and learn the member's value
    // from the public inputs alone.
    salt: Field,
    // `sig` is private to prevent cross-proof linkability (see credential_lib).
    sig: [u8; 64],
    // Merkle siblings: hash of the node that sits beside the prover's path at
    // each level, from leaf level up to (but not including) the root.
    path: [Field; DEPTH],
    // Index bits: 0 means the value-side node is the LEFT child at this level,
    // 1 means it is the RIGHT child. Each bit selects which order to pass the
    // pair into Poseidon2 so the computed root matches the canonical tree layout.
    indices: [u1; DEPTH],
    // --- public inputs ----------------------------------------------------
    // The Poseidon2 commitment binding `value` to the issuer's signature.
    commitment: pub Field,
    // secp256k1 issuer public key (checked in-circuit; contract cross-checks
    // against IssuerRegistry).
    issuer_x: pub [u8; 32],
    issuer_y: pub [u8; 32],
    // The Merkle root of the allowed-values set, published on-chain by the
    // contract. The contract MUST check this root against its stored policy root;
    // a prover who submits a self-constructed root proves nothing about the
    // allowed set.
    merkle_root: pub Field,
) {
    // --- Step 1: commitment + issuer signature ----------------------------
    // Binds the private `value` to the issuer-signed commitment and verifies the
    // issuer's secp256k1 signature in-circuit. This is identical to every other
    // credential circuit; see circuits/lib/src/lib.nr for the full rationale.
    // The `as Field` cast is lossless: u64 fits in BN254 with room to spare, and
    // Poseidon2 operates over Field, so both the commitment derivation here and
    // the leaf computation below use the same Field representation.
    credential_lib::assert_committed_and_signed(
        value as Field,
        salt,
        sig,
        commitment,
        issuer_x,
        issuer_y,
    );

    // --- Step 2: Merkle inclusion proof ----------------------------------
    // Hash the value to a leaf. Using a 1-arity Poseidon2 call over the raw
    // value (rather than reusing the commitment) keeps the leaf domain separate
    // from the credential commitment domain: the two Poseidon invocations take
    // different inputs and produce different outputs for the same value, so there
    // is no algebraic confusion between "leaf in the tree" and "commitment signed
    // by the issuer". The off-chain helper computes leaves identically.
    let mut current: Field = Poseidon2::hash([value as Field], 1);

    // Walk up the tree. At each level we recompute the parent node from
    // `current` (the running hash, starting from the leaf) and the sibling
    // stored in `path[i]`. The index bit decides which side `current` is on:
    //   index == 0  ->  parent = Poseidon2([current, sibling], 2)  (current is left)
    //   index == 1  ->  parent = Poseidon2([sibling, current], 2)  (current is right)
    //
    // This loop unrolls at compile time into exactly DEPTH Poseidon2 calls. The
    // prover cannot shorten or reorder it; every level is always evaluated.
    for i in 0..DEPTH {
        let sibling = path[i];
        let index = indices[i] as Field;
        // left  = current  if index==0,  sibling if index==1
        // right = sibling  if index==0,  current if index==1
        // Written without branching so both arms are always constrained:
        //   left  = index * sibling + (1 - index) * current
        //   right = index * current + (1 - index) * sibling
        let left  = index * sibling + (1 - index) * current;
        let right = index * current + (1 - index) * sibling;
        current = Poseidon2::hash([left, right], 2);
    }

    // After DEPTH iterations `current` must equal the canonical root. Any
    // alteration to the path, the value, or the indices produces a different
    // root and fails this assertion.
    assert(current == merkle_root);
}

// --- Tests ------------------------------------------------------------------
// Run: nargo test --package set_membership

global SM_ZERO_SIG: [u8; 64] = [0; 64];
global SM_ZERO_X:   [u8; 32] = [0; 32];
global SM_ZERO_Y:   [u8; 32] = [0; 32];

// Build a depth-8 Merkle tree over 4 real leaves padded to 256 with zero-hash
// leaves, then expose the helpers we use across multiple tests.
//
// Leaf values (same as Prover.toml): 840, 276, 566, 356
// Prover's element: 840 (index 0, leftmost leaf)
// This mirrors the sample tree in fixtures/set_membership/tree.json.
//
// LEAF HASH: Poseidon2([v], 1)
// NODE HASH: Poseidon2([left, right], 2)
//
// We compute only the minimal subtree needed for the unit tests below.
// The full tree is built off-chain by circuits/scripts/merkle_tree.js.

// Compute a leaf node hash.
fn leaf(v: Field) -> Field {
    Poseidon2::hash([v], 1)
}

// Compute an internal node hash given its children.
fn node(l: Field, r: Field) -> Field {
    Poseidon2::hash([l, r], 2)
}

// The "zero" leaf (hash of 0) used as padding for empty tree positions.
fn zero_leaf() -> Field {
    Poseidon2::hash([0], 1)
}

// Pair two zero leaves, and continue pairing up to produce the zero subtree
// root at a given height above the leaf level.
fn zero_subtree(height: u32) -> Field {
    let mut h = zero_leaf();
    for _i in 0..height {
        h = node(h, h);
    }
    h
}

// Build the root for a 4-leaf tree (indices 0..3) padded to depth 8.
// Tree layout (depth 8 = 256 leaves; only leftmost 4 are real):
//   leaves[0..3]  = leaf(840), leaf(276), leaf(566), leaf(356)
//   leaves[4..255] = zero_leaf()
// This function is deterministic and used by all tests that need the root.
fn test_root() -> Field {
    let l0 = leaf(840);
    let l1 = leaf(276);
    let l2 = leaf(566);
    let l3 = leaf(356);
    let zero = zero_leaf();

    // Level 1 (pairs of leaves)
    let n00 = node(l0, l1);
    let n01 = node(l2, l3);
    let n02 = node(zero, zero);
    let n03 = node(zero, zero);

    // Level 2
    let n10 = node(n00, n01);
    let n11 = node(n02, n03);

    // Level 3
    let mut current = node(n10, n11);

    // Levels 3..7: every remaining sibling is an all-zero subtree. The sibling
    // at level `h` is exactly `zero_subtree(h)` -- the root of a zero subtree
    // standing `h` levels above the leaf row. (Pairing `zero_subtree(h)` with
    // itself would produce `zero_subtree(h + 1)`, i.e. the sibling one level
    // too high, which is the off-by-one this helper previously had.)
    for h in 3..8 {
        current = node(current, zero_subtree(h));
    }

    current
}

// Build the Merkle path for leaf index 0 (value 840) in the test tree.
// Sibling hashes from leaf up to (not including) the root.
fn path_for_index_0() -> [Field; 8] {
    let l1 = leaf(276);
    let l2 = leaf(566);
    let l3 = leaf(356);
    let zero = zero_leaf();

    let n01 = node(l2, l3);
    let n02 = node(zero, zero);
    let n03 = node(zero, zero);
    let n11 = node(n02, n03);

    // Siblings at each level (leaf 0 is always the LEFT child at every level
    // because its binary position is 00000000):
    //   level 0: sibling = leaf(276)         = l1
    //   level 1: sibling = node(l2,l3)       = n01
    //   level 2: sibling = node(n02,n03)     = n11
    //   level 3..7: sibling = zero_subtree(h) -- the zero subtree whose root
    //   sits h levels above the leaf row. Must match test_root() exactly.
    let mut path: [Field; 8] = [0; 8];
    path[0] = l1;
    path[1] = n01;
    path[2] = n11;
    for h in 3..8 {
        path[h] = zero_subtree(h);
    }
    path
}

// --- Merkle logic-only tests (no sig/commitment overhead) -------------------

// Verify that the Merkle traversal alone produces the correct root for the
// known test tree. This test isolates the path-hashing logic from the
// credential plumbing so a failure points directly at the tree arithmetic.
#[test]
fn test_merkle_path_produces_correct_root() {
    let value: Field = 840;
    let path = path_for_index_0();
    let indices: [u1; 8] = [0, 0, 0, 0, 0, 0, 0, 0]; // leaf 0 is always left

    let mut current = Poseidon2::hash([value], 1);
    for i in 0..8 {
        let sibling = path[i];
        let index = indices[i] as Field;
        let left  = index * sibling + (1 - index) * current;
        let right = index * current + (1 - index) * sibling;
        current = Poseidon2::hash([left, right], 2);
    }

    assert(current == test_root());
}

// A non-member (value 999) should not be able to reach the root with any path,
// even if we accidentally used the path for index 0.
#[test(should_fail)]
fn test_non_member_path_rejected() {
    let value: Field = 999;
    let path = path_for_index_0();
    let indices: [u1; 8] = [0, 0, 0, 0, 0, 0, 0, 0];

    let mut current = Poseidon2::hash([value], 1);
    for i in 0..8 {
        let sibling = path[i];
        let index = indices[i] as Field;
        let left  = index * sibling + (1 - index) * current;
        let right = index * current + (1 - index) * sibling;
        current = Poseidon2::hash([left, right], 2);
    }
    // current now diverges from test_root() because the leaf hash of 999
    // does not match the leaf hash of 840 that the path was built for.
    assert(current == test_root());
}

// A valid member with a WRONG index bit flipped at level 0 produces a
// different root -- each bit must be correct.
#[test(should_fail)]
fn test_flipped_index_bit_rejected() {
    let value: Field = 840;
    let path = path_for_index_0();
    // Flip the first index bit: pretend leaf 840 is the RIGHT child.
    let indices: [u1; 8] = [1, 0, 0, 0, 0, 0, 0, 0];

    let mut current = Poseidon2::hash([value], 1);
    for i in 0..8 {
        let sibling = path[i];
        let index = indices[i] as Field;
        let left  = index * sibling + (1 - index) * current;
        let right = index * current + (1 - index) * sibling;
        current = Poseidon2::hash([left, right], 2);
    }
    assert(current == test_root());
}

// A tampered sibling hash at level 0 produces a different root.
#[test(should_fail)]
fn test_tampered_sibling_rejected() {
    let value: Field = 840;
    let mut path = path_for_index_0();
    path[0] = 0x1234; // replace the level-0 sibling with garbage
    let indices: [u1; 8] = [0, 0, 0, 0, 0, 0, 0, 0];

    let mut current = Poseidon2::hash([value], 1);
    for i in 0..8 {
        let sibling = path[i];
        let index = indices[i] as Field;
        let left  = index * sibling + (1 - index) * current;
        let right = index * current + (1 - index) * sibling;
        current = Poseidon2::hash([left, right], 2);
    }
    assert(current == test_root());
}

// --- Commitment-binding tests -----------------------------------------------

// A tampered commitment (does not match Poseidon2([value, salt], 2)) must be
// rejected at the commitment check, before the Merkle check even runs.
#[test(should_fail)]
fn test_wrong_commitment_rejected() {
    let path = path_for_index_0();
    let indices: [u1; 8] = [0, 0, 0, 0, 0, 0, 0, 0];
    main(
        840,
        0x1234,
        SM_ZERO_SIG,
        path,
        indices,
        0x0000000000000000000000000000000000000000000000000000000000000001,
        SM_ZERO_X,
        SM_ZERO_Y,
        test_root(),
    );
}

// Salt mismatch: commitment computed with real_salt, circuit called with wrong_salt.
#[test(should_fail)]
fn test_salt_mismatch_rejected() {
    let value: u64 = 840;
    let real_salt: Field = 0xdead;
    let wrong_salt: Field = 0xbeef;
    let commitment = Poseidon2::hash([value as Field, real_salt], 2);
    let path = path_for_index_0();
    let indices: [u1; 8] = [0, 0, 0, 0, 0, 0, 0, 0];
    main(value, wrong_salt, SM_ZERO_SIG, path, indices, commitment, SM_ZERO_X, SM_ZERO_Y, test_root());
}

// A zero commitment is never a valid Poseidon2 output.
#[test(should_fail)]
fn test_zero_commitment_rejected() {
    let path = path_for_index_0();
    let indices: [u1; 8] = [0, 0, 0, 0, 0, 0, 0, 0];
    main(840, 99, SM_ZERO_SIG, path, indices, 0, SM_ZERO_X, SM_ZERO_Y, test_root());
}

// Wrong value: commitment built for 840 but main called with 999. Fails at
// commitment check (Poseidon2([999, salt], 2) != commitment_of_840).
#[test(should_fail)]
fn test_value_mismatch_rejected() {
    let real_value: u64 = 840;
    let wrong_value: u64 = 999;
    let salt: Field = 0x77;
    let commitment = Poseidon2::hash([real_value as Field, salt], 2);
    let path = path_for_index_0();
    let indices: [u1; 8] = [0, 0, 0, 0, 0, 0, 0, 0];
    main(wrong_value, salt, SM_ZERO_SIG, path, indices, commitment, SM_ZERO_X, SM_ZERO_Y, test_root());
}
