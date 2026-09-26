# Architecture Decision Records

This directory contains Architecture Decision Records (ADRs) for the load-bearing design choices in StellarCred's trust model.

An ADR captures a decision that is non-obvious to a newcomer, records the alternatives that were considered, and explains the consequences — including what would have to change if the decision were revisited.

## Index

| ADR | Title | Status |
|-----|-------|--------|
| [ADR-001](ADR-001-in-circuit-signature-verification.md) | In-circuit secp256k1 signature verification | Accepted |
| [ADR-002](ADR-002-poseidon2-commitment-scheme.md) | Poseidon2 commitment scheme with mandatory non-zero salt | Accepted |
| [ADR-003](ADR-003-holder-authorized-submission.md) | Holder-authorized proof submission | Accepted |
| [ADR-004](ADR-004-public-read-default.md) | Public-by-default verification reads | Accepted |
| [ADR-005](ADR-005-ultrahonk-proving-system.md) | UltraHonk with keccak oracle hashing for on-chain verification | Accepted |

## How to read these records

Each ADR follows the same structure:

- **Status** — current standing of the decision.
- **Context** — the forces and constraints that made a decision necessary.
- **Decision** — what was chosen and precisely where it is implemented.
- **Alternatives considered** — the options that were evaluated and why they were rejected.
- **Consequences** — what the decision makes easier, what it makes harder, and what would have to change if it were revisited.

## When to write a new ADR

Write an ADR whenever a design choice has these properties:

1. It is non-obvious why this option was chosen over alternatives.
2. Reversing it would require coordinated changes across circuits, contracts, or the frontend.
3. A contributor who doesn't know the rationale could propose a change that silently breaks an intentional property.

File new ADRs as `ADR-NNN-short-title.md` and add a row to the index above.
