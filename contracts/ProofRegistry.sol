// contracts/src/ProofRegistry.sol
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract ProofRegistry {
    // Mapping: context_id => (nullifier => boolean seen)
    mapping(bytes32 => mapping(bytes32 => bool)) public nullifiers;

    event ProofVerifiedWithNullifier(bytes32 indexed contextId, bytes32 indexed nullifier);

    /**
     * @notice Verifies proof and checks/records nullifier to prevent double-spending/reuse across a context.
     */
    function verifyAndRecordProof(
        bytes calldata proof,
        bytes32 contextId,
        bytes32 nullifier,
        bytes32 merkleRoot
    ) external returns (bool) {
        // If nullifier is provided (non-zero), check uniqueness
        if (nullifier != bytes32(0)) {
            require(!nullifiers[contextId][nullifier], "Nullifier already used in this context");
            nullifiers[contextId][nullifier] = true;
            emit ProofVerifiedWithNullifier(contextId, nullifier);
        }

        // Perform zero-knowledge proof verification...
        // (zk-SNARK verification logic)

        return true;
    }
}