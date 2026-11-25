//! Optimized BN254 scalar multiplication, batch inversion, precomputed
//! fixed-base lookup tables, and Shplemini verification for Soroban (#1019).
//!
//! Why this module exists:
//! - Soroban meters every host-boundary crossing (`U256::from_u32`,
//!   `Bn254G1Affine::from_array`, `bn254_g1_msm`, `fr_mul`, `fr_inv`).
//! - The stock `ultrahonk_soroban_verifier::shplemini::verify_shplemini`
//!   zero-initializes ~396 host-allocated `Fr` and `G1Point` slots across
//!   fixed-size arrays (`[Fr; 85]`, `[Fr; 65]`, `[G1Point; 65]`, etc.),
//!   recomputes `r^j * (1 - u_j)` twice per fold round, passes `1 * shplonk_Q`
//!   and point-at-infinity commitments into `bn254_g1_msm`, and copies unused
//!   dummy fold commitments for rounds `log_n..28`.
//! - This module eliminates those redundant allocations and host calls while
//!   preserving bit-for-bit verification equivalence with Barretenberg v0.87.0.

use alloc::vec::Vec as AllocVec;
use core::ops::Neg;
use soroban_sdk::{
    crypto::bn254::{Bn254Fr, Bn254G1Affine, Bn254G2Affine},
    Bytes, Env, Vec,
};
use ultrahonk_soroban_verifier::{
    ec::{lhs_g2_affine, rhs_g2_affine},
    field::Fr,
    sumcheck::verify_sumcheck,
    transcript::generate_transcript,
    types::{
        G1Point, Proof, Transcript, VerificationKey, CONST_PROOF_SIZE_LOG_N, NUMBER_OF_ENTITIES,
        NUMBER_UNSHIFTED, PAIRING_POINTS_SIZE,
    },
    utils::{load_proof, load_vk_from_bytes},
    verifier::VerifyError,
};

/// Canonical 64-byte big-endian encoding of the BN254 G1 point at infinity.
pub const G1_INFINITY_BYTES: [u8; 64] = [0u8; 64];

/// 4-bit window size for fixed-base scalar multiplication lookup tables.
/// Table stores `[1*P, 2*P, ..., 15*P]` (15 affine points).
pub const FIXED_WINDOW_BITS: usize = 4;
pub const FIXED_WINDOW_TABLE_LEN: usize = (1 << FIXED_WINDOW_BITS) - 1;

/// Returns `true` iff `p` is the BN254 G1 point at infinity (all-zero encoding).
#[inline(always)]
pub fn is_g1_infinity(p: &Bn254G1Affine) -> bool {
    p.to_array() == G1_INFINITY_BYTES
}

/// Returns the BN254 G1 point at infinity.
#[inline(always)]
pub fn g1_infinity(env: &Env) -> Bn254G1Affine {
    Bn254G1Affine::from_array(env, &G1_INFINITY_BYTES)
}

// ---------------------------------------------------------------------------
// Pre-computed fixed-base lookup table (4-bit windowed scalar multiplication)
// ---------------------------------------------------------------------------

/// Pre-computed 4-bit window lookup table `[1*P, 2*P, ..., 15*P]` for a fixed
/// BN254 G1 base point `P`.
///
/// Building the table costs 14 `g1_add` calls once; each subsequent fixed-base
/// scalar multiplication processes 4 bits per step (64 windows for 256-bit
/// scalars), skipping all zero nibbles and performing at most 1 table lookup +
/// `g1_add` per non-zero nibble.
#[derive(Clone, Debug)]
pub struct FixedBaseTable {
    multiples: [Bn254G1Affine; FIXED_WINDOW_TABLE_LEN],
}

impl FixedBaseTable {
    /// Precompute `[1*base, 2*base, ..., 15*base]` using a single linear chain
    /// of `bn254().g1_add` operations.
    pub fn new(env: &Env, base: &Bn254G1Affine) -> Self {
        let bn = env.crypto().bn254();
        let mut pts = AllocVec::with_capacity(FIXED_WINDOW_TABLE_LEN);
        pts.push(base.clone());
        for i in 1..FIXED_WINDOW_TABLE_LEN {
            let next = bn.g1_add(&pts[i - 1], base);
            pts.push(next);
        }
        let multiples: [Bn254G1Affine; FIXED_WINDOW_TABLE_LEN] = pts
            .try_into()
            .unwrap_or_else(|_| unreachable!("table length is fixed"));
        Self { multiples }
    }

    /// Build the precomputed lookup table for the canonical BN254 G1 generator
    /// `G1 = (1, 2)`.
    pub fn g1_generator(env: &Env) -> Self {
        let gen = G1Point::generator(env).0;
        Self::new(env, &gen)
    }

    /// Look up `k * base` for `1 <= k <= 15`.
    #[inline(always)]
    pub fn get(&self, nibble: u8) -> &Bn254G1Affine {
        &self.multiples[(nibble - 1) as usize]
    }

    /// Compute `scalar * base` using 4-bit fixed-window Horner evaluation.
    ///
    /// Leading zero nibbles are skipped without any point doublings, so small
    /// scalars (e.g. 64-bit or 128-bit) pay proportionally fewer doublings.
    pub fn mul(&self, env: &Env, scalar: &Bn254Fr) -> Bn254G1Affine {
        let bytes = scalar.to_bytes().to_array();
        let bn = env.crypto().bn254();

        let mut acc: Option<Bn254G1Affine> = None;

        for &byte in &bytes {
            let hi = byte >> 4;
            let lo = byte & 0x0f;

            for nibble in [hi, lo] {
                if let Some(ref mut cur) = acc {
                    // 4 doublings: cur = 16 * cur
                    for _ in 0..FIXED_WINDOW_BITS {
                        *cur = bn.g1_add(cur, cur);
                    }
                    if nibble != 0 {
                        *cur = bn.g1_add(cur, self.get(nibble));
                    }
                } else if nibble != 0 {
                    acc = Some(self.get(nibble).clone());
                }
            }
        }

        acc.unwrap_or_else(|| g1_infinity(env))
    }
}

// ---------------------------------------------------------------------------
// Montgomery batch inversion & batch affine normalization
// ---------------------------------------------------------------------------

/// Compute the modular inverse of every element in `vals` in-place using
/// Montgomery's trick: **1** field inversion + `3 * (n - 1)` multiplications.
///
/// Unlike the stock `batch_inverse(&vals, &mut out)`, this allocates only a
/// single `Vec::with_capacity(n)` for prefix products and writes the inverses
/// directly back into `vals`, eliminating the second pre-zeroed host array.
pub fn batch_invert_fr_in_place(vals: &mut [Fr]) -> Result<(), &'static str> {
    let n = vals.len();
    if n == 0 {
        return Ok(());
    }
    if n == 1 {
        if vals[0].is_zero() {
            return Err("denominator is zero");
        }
        vals[0] = vals[0].inverse();
        return Ok(());
    }

    let mut prefixes = AllocVec::with_capacity(n);
    prefixes.push(vals[0].clone());
    for i in 1..n {
        let next = &prefixes[i - 1] * &vals[i];
        prefixes.push(next);
    }

    if prefixes[n - 1].is_zero() {
        return Err("denominator is zero");
    }

    let mut inv_acc = prefixes[n - 1].inverse();
    for i in (1..n).rev() {
        let orig = vals[i].clone();
        vals[i] = &inv_acc * &prefixes[i - 1];
        inv_acc = &inv_acc * &orig;
    }
    vals[0] = inv_acc;
    Ok(())
}

/// A G1 point paired with a scalar denominator `z` representing the scaled
/// affine point `z^{-1} * point`.
#[derive(Clone, Debug)]
pub struct WeightedG1Point {
    pub point: Bn254G1Affine,
    pub denominator: Fr,
}

/// Batch-normalize a slice of `WeightedG1Point`s into affine G1 points
/// `denominator_i^{-1} * point_i` using a single Montgomery batch inversion
/// instead of `n` individual field inversions.
///
/// Points at infinity are passed through directly without invoking `g1_mul`;
/// unit denominators (`z == 1`) skip scalar multiplication as well.
pub fn batch_normalize_weighted_g1(
    env: &Env,
    weighted: &[WeightedG1Point],
) -> Result<AllocVec<Bn254G1Affine>, &'static str> {
    if weighted.is_empty() {
        return Ok(AllocVec::new());
    }

    let one = Fr::one(env);
    let mut denoms = AllocVec::with_capacity(weighted.len());
    for item in weighted {
        denoms.push(item.denominator.clone());
    }
    batch_invert_fr_in_place(&mut denoms)?;

    let bn = env.crypto().bn254();
    let mut out = AllocVec::with_capacity(weighted.len());
    for (item, inv_z) in weighted.iter().zip(denoms.iter()) {
        if is_g1_infinity(&item.point) {
            out.push(g1_infinity(env));
        } else if *inv_z == one {
            out.push(item.point.clone());
        } else {
            out.push(bn.g1_mul(&item.point, &inv_z.0));
        }
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// Optimized multi-scalar multiplication & pairing check
// ---------------------------------------------------------------------------

/// Compute `sum_i scalars[i] * points[i]` on BN254 G1 with host-budget
/// optimizations:
///
/// 1. Drops zero-scalar terms (`s == 0`) before the host MSM boundary.
/// 2. Drops identity-point terms (`P == O`) before the host MSM boundary
///    (many circuits have unused selector commitments equal to infinity).
/// 3. Folds unit scalars (`s == 1`) and negated unit scalars (`s == -1`) via
///    cheap `bn254().g1_add` instead of paying a 256-bit scalar multiplication
///    term inside `bn254_g1_msm`.
/// 4. Deduplicates identical G1 points by summing their scalars in `Fr`,
///    shrinking the Pippenger MSM input vector.
/// 5. Dispatches remaining general terms in a single `bn254().g1_msm` call.
pub fn optimized_g1_msm(
    env: &Env,
    points: &[Bn254G1Affine],
    scalars: &[Fr],
) -> Result<Bn254G1Affine, &'static str> {
    if points.len() != scalars.len() {
        return Err("msm len mismatch");
    }

    let zero = Fr::zero(env);
    let one = Fr::one(env);
    let minus_one = Fr::minus_one(env);
    let bn = env.crypto().bn254();

    let mut unit_acc: Option<Bn254G1Affine> = None;
    let mut dedup_bytes: AllocVec<[u8; 64]> = AllocVec::with_capacity(points.len());
    let mut dedup_pts: AllocVec<Bn254G1Affine> = AllocVec::with_capacity(points.len());
    let mut dedup_scalars: AllocVec<Fr> = AllocVec::with_capacity(points.len());

    for (p, s) in points.iter().zip(scalars.iter()) {
        if *s == zero {
            continue;
        }
        let raw = p.to_array();
        if raw == G1_INFINITY_BYTES {
            continue;
        }

        // Check if this exact G1 point already appeared; if so, merge scalars.
        if let Some(pos) = dedup_bytes.iter().position(|b| *b == raw) {
            dedup_scalars[pos] = &dedup_scalars[pos] + s;
            continue;
        }

        if *s == one {
            unit_acc = Some(match unit_acc {
                Some(acc) => bn.g1_add(&acc, p),
                None => p.clone(),
            });
            continue;
        }
        if *s == minus_one {
            let neg_p = p.clone().neg();
            unit_acc = Some(match unit_acc {
                Some(acc) => bn.g1_add(&acc, &neg_p),
                None => neg_p,
            });
            continue;
        }

        dedup_bytes.push(raw);
        dedup_pts.push(p.clone());
        dedup_scalars.push(s.clone());
    }

    let mut vp: Vec<Bn254G1Affine> = Vec::new(env);
    let mut vs: Vec<Bn254Fr> = Vec::new(env);

    for (p, s) in dedup_pts.into_iter().zip(dedup_scalars.into_iter()) {
        if s == zero {
            continue;
        }
        if s == one {
            unit_acc = Some(match unit_acc {
                Some(acc) => bn.g1_add(&acc, &p),
                None => p,
            });
            continue;
        }
        if s == minus_one {
            let neg_p = p.neg();
            unit_acc = Some(match unit_acc {
                Some(acc) => bn.g1_add(&acc, &neg_p),
                None => neg_p,
            });
            continue;
        }
        vp.push_back(p);
        vs.push_back(s.0);
    }

    let msm_res = if vp.is_empty() {
        None
    } else {
        Some(bn.g1_msm(vp, vs))
    };

    Ok(match (msm_res, unit_acc) {
        (Some(m), Some(u)) => bn.g1_add(&m, &u),
        (Some(m), None) => m,
        (None, Some(u)) => u,
        (None, None) => g1_infinity(env),
    })
}

/// Pairing product check `e(p0, rhs_g2) * e(p1, lhs_g2) == 1`.
///
/// Short-circuits when both G1 points are the point at infinity (trivially 1)
/// and avoids including identity terms in the pairing vector.
#[inline(always)]
pub fn optimized_pairing_check(env: &Env, p0: &Bn254G1Affine, p1: &Bn254G1Affine) -> bool {
    let p0_inf = is_g1_infinity(p0);
    let p1_inf = is_g1_infinity(p1);
    if p0_inf && p1_inf {
        return true;
    }

    let mut g1s: Vec<Bn254G1Affine> = Vec::new(env);
    let mut g2s: Vec<Bn254G2Affine> = Vec::new(env);
    if !p0_inf {
        g1s.push_back(p0.clone());
        g2s.push_back(rhs_g2_affine(env));
    }
    if !p1_inf {
        g1s.push_back(p1.clone());
        g2s.push_back(lhs_g2_affine(env));
    }
    env.crypto().bn254().pairing_check(g1s, g2s)
}

// ---------------------------------------------------------------------------
// Fast-path VK header inspection & optimized UltraHonk verification
// ---------------------------------------------------------------------------

/// Expected VK byte length for Barretenberg v0.87.0 UltraHonk (32-byte header
/// + 27 G1 commitments of 64 bytes each).
const VK_HEADER_BYTES: usize = 32;

/// Read `public_inputs_size` directly from the 32-byte VK header (bytes 16..24)
/// before paying the cost of deserializing all 27 G1 commitments.
///
/// Returns `None` if `vk_bytes` is shorter than the 32-byte header.
#[inline]
pub(crate) fn peek_vk_public_inputs_size(vk_bytes: &Bytes) -> Option<u64> {
    if (vk_bytes.len() as usize) < VK_HEADER_BYTES {
        return None;
    }
    let mut buf = [0u8; 8];
    vk_bytes.slice(16..24).copy_into_slice(&mut buf);
    Some(u64::from_be_bytes(buf))
}

/// Compute the permutation grand-product public-input delta while reading
/// `public_inputs` in a single contiguous copy rather than creating a new host
/// `Bytes` slice per 32-byte input.
fn compute_public_input_delta_fast(
    env: &Env,
    public_inputs: &Bytes,
    pairing_point_object: &[Fr],
    beta: &Fr,
    gamma: &Fr,
    offset: u64,
    n: u64,
) -> Result<Fr, &'static str> {
    let mut numerator = Fr::one(env);
    let mut denominator = Fr::one(env);

    let beta_n = beta * &Fr::from_u64(env, n + offset);
    let beta_off = beta * &Fr::from_u64(env, offset + 1);
    let mut numerator_acc = gamma + beta_n;
    let mut denominator_acc = gamma - &beta_off;

    let total_len = public_inputs.len() as usize;
    if total_len > 0 {
        let mut raw = alloc::vec![0u8; total_len];
        public_inputs.copy_into_slice(&mut raw);
        for chunk in raw.chunks_exact(32) {
            let word: &[u8; 32] = chunk.try_into().expect("32-byte chunk");
            let pi = Fr::from_array(env, word);
            numerator = &numerator * &(&numerator_acc + &pi);
            denominator = &denominator * &(&denominator_acc + &pi);
            numerator_acc = &numerator_acc + beta;
            denominator_acc = &denominator_acc - beta;
        }
    }

    for public_input in pairing_point_object {
        numerator = &numerator * &(&numerator_acc + public_input);
        denominator = &denominator * &(&denominator_acc + public_input);
        numerator_acc = &numerator_acc + beta;
        denominator_acc = &denominator_acc - beta;
    }

    if denominator.is_zero() {
        return Err("denominator is zero in public_input_delta");
    }
    Ok(numerator * denominator.inverse())
}

/// Optimized Shplemini batch-opening verifier (Gemini + Shplonk + KZG).
///
/// Key optimizations over stock `ultrahonk_soroban_verifier::shplemini`:
/// 1. **Zero wasted host allocations**: dynamically sized `Vec::with_capacity`
///    scoped to the circuit's actual `log_n` instead of pre-zeroing ~396 host
///    `Fr`/`G1Point` slots.
/// 2. **In-place Montgomery batch inversion**: single buffer for all
///    `3 * log_n + 1` denominators.
/// 3. **Reuse of `r^j * (1 - u_j)` across fold rounds**: eliminates `log_n`
///    redundant `Fr` multiplications and subtractions.
/// 4. **Zero dummy fold commitment copies**: only active rounds `1..log_n` are
///    pushed into the MSM.
/// 5. **Optimized G1 MSM**: skips zero scalars, skips point-at-infinity
///    commitments, folds `1 * shplonk_Q` via `g1_add`, and deduplicates
///    identical G1 points before calling host-native Pippenger `g1_msm`.
pub(crate) fn verify_shplemini_optimized(
    env: &Env,
    proof: &Proof,
    vk: &VerificationKey,
    tp: &Transcript,
) -> Result<(), &'static str> {
    let log_n = vk.log_circuit_size as usize;
    if log_n == 0 || log_n > CONST_PROOF_SIZE_LOG_N {
        return Err("shplemini: log_circuit_size out of range");
    }

    let one = Fr::one(env);
    let two = Fr::from_u64(env, 2);

    // 1) Powers r^{2^i} for i in 0..log_n (only log_n entries, no 28-slot zero fill)
    let mut r_pows = AllocVec::with_capacity(log_n);
    r_pows.push(tp.gemini_r.clone());
    for i in 1..log_n {
        let sq = &r_pows[i - 1] * &r_pows[i - 1];
        r_pows.push(sq);
    }

    // 2) Collect all 3*log_n + 1 denominators and invert in-place in one pass.
    //    Also cache `fold_lin[log_n - j] = r^{2^{j-1}} * (1 - u_{j-1}) - u_{j-1}`
    //    so step 5 doesn't recompute `r^{2^{j-1}} * (1 - u_{j-1})`.
    let batch_size = 3 * log_n + 1;
    let mut denoms = AllocVec::with_capacity(batch_size);
    let mut fold_lin_terms = AllocVec::with_capacity(log_n);

    denoms.push(&tp.shplonk_z - &r_pows[0]); // [0]: z - r^0
    denoms.push(&tp.shplonk_z + &r_pows[0]); // [1]: z + r^0
    denoms.push(tp.gemini_r.clone()); // [2]: gemini_r

    // [3 .. 3 + log_n): fold round denominators for j = log_n down to 1
    for j in (1..=log_n).rev() {
        let u = &tp.sumcheck_u_challenges[j - 1];
        let scaled = &r_pows[j - 1] * &(&one - u);
        denoms.push(&scaled + u);
        fold_lin_terms.push(&scaled - u);
    }

    // [3 + log_n .. 3*log_n + 1): (z - r^j, z + r^j) for j = 1..log_n
    let further_base = 3 + log_n;
    for r_j in &r_pows[1..log_n] {
        denoms.push(&tp.shplonk_z - r_j);
        denoms.push(&tp.shplonk_z + r_j);
    }

    batch_invert_fr_in_place(&mut denoms).map_err(|_| {
        "shplemini: batch inversion failed (zero denominator in shplonk/gemini/fold)"
    })?;

    if denoms.iter().any(|x| x.is_zero()) {
        return Err("shplemini: batch inversion produced zero result");
    }

    let pos0 = &denoms[0];
    let neg0 = &denoms[1];
    let gemini_r_inv = &denoms[2];

    // 3) Compute Shplonk weights
    let nu_neg0 = &tp.shplonk_nu * neg0;
    let unshifted = &nu_neg0 + pos0;
    let shifted = gemini_r_inv * &(pos0 - &nu_neg0);
    let neg_unshifted = -&unshifted;
    let neg_shifted = -&shifted;

    // 4) Weight sumcheck evaluations and accumulate `eval_acc = sum rho^i * eval_i`
    let mut eval_scalars = AllocVec::with_capacity(NUMBER_OF_ENTITIES);
    let mut rho_pow = one.clone();
    let mut eval_acc = Fr::zero(env);

    for (idx, eval) in proof
        .sumcheck_evaluations
        .iter()
        .take(NUMBER_OF_ENTITIES)
        .enumerate()
    {
        if idx == 0 {
            eval_scalars.push(neg_unshifted.clone());
            eval_acc = eval.clone();
            rho_pow = tp.rho.clone();
        } else {
            let weight = if idx < NUMBER_UNSHIFTED {
                &neg_unshifted
            } else {
                &neg_shifted
            };
            eval_scalars.push(weight * &rho_pow);
            eval_acc = &eval_acc + &(eval * &rho_pow);
            if idx + 1 < NUMBER_OF_ENTITIES {
                rho_pow = &rho_pow * &tp.rho;
            }
        }
    }

    // Merge shifted wire scalars into their unshifted counterparts.
    for (unshifted_idx, shifted_idx) in [(27, 35), (28, 36), (29, 37), (30, 38), (31, 39)] {
        eval_scalars[unshifted_idx] = &eval_scalars[unshifted_idx] + &eval_scalars[shifted_idx];
    }

    // 5) Folding rounds — reuse cached `fold_lin_terms` and batch-inverted denoms
    let mut fold_pos_rev = AllocVec::with_capacity(log_n);
    let mut cur = eval_acc;
    for step in 0..log_n {
        let j = log_n - step;
        let r2 = &r_pows[j - 1];
        let fold_lin = &fold_lin_terms[step];
        let num = &(r2 * &cur) * &two - &(&proof.gemini_a_evaluations[j - 1] * fold_lin);
        cur = &num * &denoms[3 + step];
        fold_pos_rev.push(cur.clone());
    }
    // fold_pos_rev[step] corresponds to j = log_n - step, so index for j is `log_n - j`
    // (i.e. j = 1 -> index log_n - 1, j = log_n -> index 0).

    // 6) Assemble active MSM terms directly (no dummy zero-padded slots)
    let active_terms = 1 + NUMBER_UNSHIFTED + (log_n - 1) + 2;
    let mut msm_points = AllocVec::with_capacity(active_terms);
    let mut msm_scalars = AllocVec::with_capacity(active_terms);

    // [0] shplonk_Q with scalar 1 (folded via g1_add inside optimized_g1_msm)
    msm_points.push(proof.shplonk_q.0.clone());
    msm_scalars.push(one);

    // [1..=27] VK precomputed commitments
    let vk_coms: [&G1Point; 27] = [
        &vk.qm,
        &vk.qc,
        &vk.ql,
        &vk.qr,
        &vk.qo,
        &vk.q4,
        &vk.q_lookup,
        &vk.q_arith,
        &vk.q_delta_range,
        &vk.q_elliptic,
        &vk.q_aux,
        &vk.q_poseidon2_external,
        &vk.q_poseidon2_internal,
        &vk.s1,
        &vk.s2,
        &vk.s3,
        &vk.s4,
        &vk.id1,
        &vk.id2,
        &vk.id3,
        &vk.id4,
        &vk.t1,
        &vk.t2,
        &vk.t3,
        &vk.t4,
        &vk.lagrange_first,
        &vk.lagrange_last,
    ];
    for (i, com) in vk_coms.iter().enumerate() {
        msm_points.push(com.0.clone());
        msm_scalars.push(eval_scalars[i].clone());
    }

    // [28..=35] Proof witness & lookup commitments
    let proof_coms: [&G1Point; 8] = [
        &proof.w1,
        &proof.w2,
        &proof.w3,
        &proof.w4,
        &proof.z_perm,
        &proof.lookup_inverses,
        &proof.lookup_read_counts,
        &proof.lookup_read_tags,
    ];
    for (offset, com) in proof_coms.iter().enumerate() {
        msm_points.push(com.0.clone());
        msm_scalars.push(eval_scalars[27 + offset].clone());
    }

    // 7) Constant term and active Gemini fold commitments (only 1..log_n)
    let nu_sq = &tp.shplonk_nu * &tp.shplonk_nu;
    let fold_pos_0 = &fold_pos_rev[log_n - 1];
    let mut const_acc =
        &(fold_pos_0 * pos0) + &(&(&proof.gemini_a_evaluations[0] * &tp.shplonk_nu) * neg0);
    let mut v_pow = nu_sq.clone();

    for j in 1..log_n {
        let pos_inv = &denoms[further_base + 2 * (j - 1)];
        let neg_inv = &denoms[further_base + 2 * (j - 1) + 1];
        let sp = &v_pow * pos_inv;
        let sn = &(&v_pow * &tp.shplonk_nu) * neg_inv;

        msm_points.push(proof.gemini_fold_comms[j - 1].0.clone());
        msm_scalars.push(-(&sp + &sn));

        let fold_pos_j = &fold_pos_rev[log_n - 1 - j];
        const_acc = &const_acc + &(&proof.gemini_a_evaluations[j] * &sn) + &(fold_pos_j * &sp);

        if j + 1 < log_n {
            v_pow = &v_pow * &nu_sq;
        }
    }

    // Generator with const_acc scalar
    msm_points.push(G1Point::generator(env).0);
    msm_scalars.push(const_acc);

    // KZG quotient with scalar z
    msm_points.push(proof.kzg_quotient.0.clone());
    msm_scalars.push(tp.shplonk_z.clone());

    // 8) Optimized MSM + pairing check
    let p0 = optimized_g1_msm(env, &msm_points, &msm_scalars)?;
    let p1 = proof.kzg_quotient.0.clone().neg();
    if optimized_pairing_check(env, &p0, &p1) {
        Ok(())
    } else {
        Err("Shplonk pairing check failed")
    }
}

/// Full UltraHonk verification using fast public-input validation, contiguous
/// delta computation, and [`verify_shplemini_optimized`].
pub(crate) fn verify_ultrahonk_optimized(
    env: &Env,
    vk_bytes: &Bytes,
    proof_bytes: &Bytes,
    public_inputs_bytes: &Bytes,
) -> Result<(), VerifyError> {
    // 0) Fast-path public_inputs length check before parsing any VK G1 points
    if !public_inputs_bytes.len().is_multiple_of(32) {
        return Err(VerifyError::InvalidInput);
    }
    let provided = (public_inputs_bytes.len() / 32) as u64;
    if let Some(vk_pi_size) = peek_vk_public_inputs_size(vk_bytes) {
        let expected = vk_pi_size
            .checked_sub(PAIRING_POINTS_SIZE as u64)
            .ok_or(VerifyError::InvalidInput)?;
        if expected != provided {
            return Err(VerifyError::InvalidInput);
        }
    }

    // 1) Parse VK and proof
    let vk = load_vk_from_bytes(env, vk_bytes).map_err(|_| VerifyError::InvalidInput)?;
    let expected = vk
        .public_inputs_size
        .checked_sub(PAIRING_POINTS_SIZE as u64)
        .ok_or(VerifyError::InvalidInput)?;
    if expected != provided {
        return Err(VerifyError::InvalidInput);
    }

    let proof = load_proof(env, proof_bytes).map_err(|_| VerifyError::InvalidInput)?;

    // 2) Fiat-Shamir transcript
    let pis_total = provided + PAIRING_POINTS_SIZE as u64;
    let pub_inputs_offset = vk.pub_inputs_offset;
    let mut t = generate_transcript(
        env,
        &proof,
        public_inputs_bytes,
        vk.circuit_size,
        pis_total,
        pub_inputs_offset,
    )
    .map_err(|_| VerifyError::InvalidInput)?;

    // 3) Public input delta (contiguous read)
    t.rel_params.public_inputs_delta = compute_public_input_delta_fast(
        env,
        public_inputs_bytes,
        &proof.pairing_point_object,
        &t.rel_params.beta,
        &t.rel_params.gamma,
        pub_inputs_offset,
        vk.circuit_size,
    )
    .map_err(|_| VerifyError::InvalidInput)?;

    // 4) Sum-check
    verify_sumcheck(env, &proof, &t, &vk).map_err(|_| VerifyError::SumcheckFailed)?;

    // 5) Optimized Shplemini (in-place batch inversion + optimized MSM + pairing)
    verify_shplemini_optimized(env, &proof, &vk, &t).map_err(|_| VerifyError::ShplonkFailed)?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{Bytes, Env};
    use test_support::{AGE, KYC, SET_MEMBERSHIP};
    use ultrahonk_soroban_verifier::{ec::g1_msm as stock_g1_msm, UltraHonkVerifier};

    #[test]
    fn fixed_base_table_matches_host_g1_mul() {
        let env = Env::default();
        let bn = env.crypto().bn254();
        let gen = G1Point::generator(&env).0;
        let table = FixedBaseTable::g1_generator(&env);

        // Verify every precomputed table slot 1..=15
        for k in 1u64..=15 {
            let expected = bn.g1_mul(&gen, &Fr::from_u64(&env, k).0);
            assert_eq!(table.get(k as u8), &expected);
        }

        // Test edge-case and full-width scalars
        let test_scalars = [
            Fr::zero(&env),
            Fr::one(&env),
            Fr::from_u64(&env, 15),
            Fr::from_u64(&env, 16),
            Fr::from_u64(&env, 255),
            Fr::from_u64(&env, 0x1234_5678_9abc_def0),
            Fr::minus_one(&env),
            Fr::neg_half(&env),
        ];

        for s in &test_scalars {
            let got = table.mul(&env, &s.0);
            let expected = if s.is_zero() {
                g1_infinity(&env)
            } else {
                bn.g1_mul(&gen, &s.0)
            };
            assert_eq!(got, expected);
        }

        // Non-generator base point (7 * G1)
        let base7 = bn.g1_mul(&gen, &Fr::from_u64(&env, 7).0);
        let table7 = FixedBaseTable::new(&env, &base7);
        let scalar = Fr::from_u64(&env, 0xdead_beef);
        assert_eq!(table7.mul(&env, &scalar.0), bn.g1_mul(&base7, &scalar.0));
    }

    #[test]
    fn batch_invert_fr_in_place_handles_empty_single_batch_and_zero() {
        let env = Env::default();

        // Empty
        let mut empty: [Fr; 0] = [];
        assert_eq!(batch_invert_fr_in_place(&mut empty), Ok(()));

        // Single
        let mut single = [Fr::from_u64(&env, 42)];
        let orig = single[0].clone();
        batch_invert_fr_in_place(&mut single).unwrap();
        assert_eq!(&orig * &single[0], Fr::one(&env));

        // Batch of 8 distinct values
        let originals = [
            Fr::from_u64(&env, 2),
            Fr::from_u64(&env, 3),
            Fr::from_u64(&env, 5),
            Fr::from_u64(&env, 7),
            Fr::from_u64(&env, 11),
            Fr::from_u64(&env, 13),
            Fr::minus_one(&env),
            Fr::neg_half(&env),
        ];
        let mut invs = originals.clone();
        batch_invert_fr_in_place(&mut invs).unwrap();
        for (a, inv) in originals.iter().zip(invs.iter()) {
            assert_eq!(a * inv, Fr::one(&env));
        }

        // Zero element triggers error
        let mut with_zero = [
            Fr::from_u64(&env, 9),
            Fr::zero(&env),
            Fr::from_u64(&env, 17),
        ];
        assert_eq!(
            batch_invert_fr_in_place(&mut with_zero),
            Err("denominator is zero")
        );
    }

    #[test]
    fn batch_normalize_weighted_g1_recovers_affine_points() {
        let env = Env::default();
        let bn = env.crypto().bn254();
        let gen = G1Point::generator(&env).0;

        let p1 = bn.g1_mul(&gen, &Fr::from_u64(&env, 5).0);
        let p2 = bn.g1_mul(&gen, &Fr::from_u64(&env, 11).0);
        let p3 = g1_infinity(&env);

        let z1 = Fr::from_u64(&env, 13);
        let z2 = Fr::one(&env);
        let z3 = Fr::from_u64(&env, 29);

        let weighted = [
            WeightedG1Point {
                point: bn.g1_mul(&p1, &z1.0),
                denominator: z1,
            },
            WeightedG1Point {
                point: p2.clone(),
                denominator: z2,
            },
            WeightedG1Point {
                point: p3.clone(),
                denominator: z3,
            },
        ];

        let normalized = batch_normalize_weighted_g1(&env, &weighted).unwrap();
        assert_eq!(normalized.len(), 3);
        assert_eq!(normalized[0], p1);
        assert_eq!(normalized[1], p2);
        assert_eq!(normalized[2], p3);

        // Zero denominator fails cleanly
        let bad = [WeightedG1Point {
            point: p1,
            denominator: Fr::zero(&env),
        }];
        assert_eq!(
            batch_normalize_weighted_g1(&env, &bad),
            Err("denominator is zero")
        );
    }

    #[test]
    fn optimized_g1_msm_matches_stock_and_handles_edge_cases() {
        let env = Env::default();
        let bn = env.crypto().bn254();
        let gen = G1Point::generator(&env).0;
        let p2 = bn.g1_mul(&gen, &Fr::from_u64(&env, 2).0);
        let p3 = bn.g1_mul(&gen, &Fr::from_u64(&env, 3).0);
        let inf = g1_infinity(&env);

        // Length mismatch
        assert_eq!(
            optimized_g1_msm(&env, core::slice::from_ref(&gen), &[]),
            Err("msm len mismatch")
        );

        // Empty / zero / infinity -> infinity
        assert_eq!(optimized_g1_msm(&env, &[], &[]).unwrap(), inf);
        assert_eq!(
            optimized_g1_msm(
                &env,
                &[gen.clone(), inf.clone()],
                &[Fr::zero(&env), Fr::from_u64(&env, 99)]
            )
            .unwrap(),
            inf
        );

        // Mixed: unit (+1, -1), duplicate points (p2 appears twice), cancelling
        // duplicates (p3 with +4 and -4), zero scalar, infinity point, and general scalar
        let points = [
            gen.clone(), // * 1
            p2.clone(),  // * 5
            p2.clone(),  // * 7 (merged -> 12 * p2)
            p3.clone(),  // * 4
            p3.clone(),  // * -4 (cancels to 0)
            gen.clone(), // * -1 (cancels with first +1 -> 0)
            inf.clone(), // * 123 (skipped)
            p2.clone(),  // * 0 (skipped)
            p3.clone(),  // * 19
        ];
        let scalars = [
            Fr::one(&env),
            Fr::from_u64(&env, 5),
            Fr::from_u64(&env, 7),
            Fr::from_u64(&env, 4),
            -Fr::from_u64(&env, 4),
            Fr::minus_one(&env),
            Fr::from_u64(&env, 123),
            Fr::zero(&env),
            Fr::from_u64(&env, 19),
        ];

        let got = optimized_g1_msm(&env, &points, &scalars).unwrap();
        let stock_pts: AllocVec<G1Point> = points.iter().cloned().map(G1Point).collect();
        let expected = stock_g1_msm(&env, &stock_pts, &scalars).unwrap();
        assert_eq!(got, expected);
    }

    #[test]
    fn optimized_pairing_check_short_circuits_identity() {
        let env = Env::default();
        let inf = g1_infinity(&env);
        assert!(optimized_pairing_check(&env, &inf, &inf));
    }

    #[test]
    fn optimized_verifier_reduces_cpu_and_memory_budget_on_real_circuits() {
        for circuit in [&KYC, &AGE, &SET_MEMBERSHIP] {
            // Measure stock UltraHonkVerifier
            let stock_env = Env::default();
            let stock_vk = circuit.vk_bytes(&stock_env);
            let stock_proof = circuit.proof_bytes(&stock_env);
            let stock_pi = circuit.public_inputs_bytes(&stock_env);
            stock_env.cost_estimate().budget().reset_default();
            let stock_ok = UltraHonkVerifier::new(&stock_env, &stock_vk)
                .and_then(|v| {
                    v.verify(&stock_env, &stock_proof, &stock_pi)
                        .map_err(|_| ultrahonk_soroban_verifier::VkLoadError::InvalidParameters)
                })
                .is_ok();
            let stock_cpu = stock_env.cost_estimate().budget().cpu_instruction_cost();
            let stock_mem = stock_env.cost_estimate().budget().memory_bytes_cost();
            assert!(stock_ok, "stock verifier should accept {}", circuit.name);

            // Measure optimized verifier
            let opt_env = Env::default();
            let opt_vk = circuit.vk_bytes(&opt_env);
            let opt_proof = circuit.proof_bytes(&opt_env);
            let opt_pi = circuit.public_inputs_bytes(&opt_env);
            opt_env.cost_estimate().budget().reset_default();
            let opt_ok = verify_ultrahonk_optimized(&opt_env, &opt_vk, &opt_proof, &opt_pi).is_ok();
            let opt_cpu = opt_env.cost_estimate().budget().cpu_instruction_cost();
            let opt_mem = opt_env.cost_estimate().budget().memory_bytes_cost();
            assert!(opt_ok, "optimized verifier should accept {}", circuit.name);

            assert!(
                opt_cpu < stock_cpu,
                "expected optimized CPU ({opt_cpu}) < stock CPU ({stock_cpu}) for {}",
                circuit.name
            );
            assert!(
                opt_mem < stock_mem,
                "expected optimized memory ({opt_mem}) < stock memory ({stock_mem}) for {}",
                circuit.name
            );
        }
    }

    #[test]
    fn fast_path_rejects_malformed_public_inputs_before_vk_deserialization() {
        let env = Env::default();
        let vk = KYC.vk_bytes(&env);
        let proof = KYC.proof_bytes(&env);
        // Non-32-byte-aligned public inputs
        let bad_pi = Bytes::from_array(&env, &[1u8; 31]);
        assert!(verify_ultrahonk_optimized(&env, &vk, &proof, &bad_pi).is_err());

        // Wrong count of 32-byte public inputs (1 instead of expected)
        let wrong_count_pi = Bytes::from_array(&env, &[0u8; 32]);
        assert!(verify_ultrahonk_optimized(&env, &vk, &proof, &wrong_count_pi).is_err());
    }
}
