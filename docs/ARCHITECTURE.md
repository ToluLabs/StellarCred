# StellarCred Architecture

This document describes the overall architecture of StellarCred, including trust boundaries and data flows.

## Trust Boundaries

StellarCred is designed with strict privacy guarantees:
- **Identity data never leaves the browser** except for direct interactions with KYC providers (e.g., Persona).
- No raw identity data is stored on-chain or in backend services.
- Only cryptographic commitments and zero-knowledge proofs are published on the Stellar blockchain.

## High-Level Component Diagram

The diagram below shows the key components and their interactions. It also highlights the trust boundaries.

```mermaid
graph TD
    subgraph Browser
        Prover[Prover Engine<br/>Noir + bb.js]
        Wallet[Connected Wallet<br/>Freighter/other]
    end
    subgraph Backend
        IssueEndpoint[/api/issue]
        KYCProvider[KYC Provider<br/>Persona/Plaid]
    end
    subgraph StellarSoroban["Stellar Soroban Contracts"]
        ProofRegistry[ProofRegistry]
        IssuerRegistry[IssuerRegistry]
        CredentialVerifier[CredentialVerifier]
    end
    subgraph ConsumingProtocols["Consuming Protocols"]
        ProtocolDapp[Protocol dApp]
    end
    
    Browser -->|1. Request Credential| IssueEndpoint
    IssueEndpoint -->|2. Verify Identity| KYCProvider
    KYCProvider -->|3. Verification Result| IssueEndpoint
    IssueEndpoint -->|4. Signed Credential| Browser
    Browser -->|5. Generate Proof Locally| Prover
    Prover -->|6. Proof + Public Inputs| Wallet
    Wallet -->|7. submit_proof| ProofRegistry
    ProofRegistry -->|8. is_valid_issuer| IssuerRegistry
    ProofRegistry -->|9. verify_proof| CredentialVerifier
    ProofRegistry -->|10. is_verified State| ProtocolDapp
```

## Credential Issuance Flow

This sequence diagram shows how a holder obtains a signed credential from the issuer.

```mermaid
sequenceDiagram
    autonumber
    participant Holder as Holder
    participant Browser as Browser
    participant API as /api/issue
    participant KYC as KYC Provider
    
    Holder->>Browser: Initiate Verification
    Browser->>API: POST /api/issue (credential types, holder, issuer_id, ...)
    alt Needs KYC (e.g., "kyc" type requested)
        API->>KYC: Create Persona Inquiry
        KYC-->>API: Inquiry ID + Hosted URL
        API-->>Browser: needsPersona: true + personaUrl
        Browser->>KYC: Redirect to Persona Hosted Flow
        Holder->>KYC: Complete Identity Verification
        KYC-->>Browser: Redirect Back with inquiryId
        Browser->>API: POST /api/issue + persona_inquiry_id
    end
    API->>KYC: Retrieve Inquiry Status
    KYC-->>API: Approved + Identity Attributes
    API->>API: Generate Value + Salt for each Credential Type
    API->>API: Compute Poseidon2 Commitment
    API->>API: Sign Commitment with ISSUER_PRIVATE_KEY
    API-->>Browser: Return Signed Credentials
    Browser->>Browser: Store Credentials Locally (never on server)
    Note over API,Browser: Raw Identity Data Only Exists Here (KYC Provider)
```

**Privacy Note:** Raw identity attributes (like date of birth, country code) are only sent to and stored by the KYC provider. They are never stored by /api/issue or written to the blockchain.

## Proving and Verification Flow

This sequence diagram shows how a holder generates a zero-knowledge proof locally and submits it to the ProofRegistry contract.

```mermaid
sequenceDiagram
    autonumber
    participant Holder as Holder
    participant Browser as Browser
    participant Prover as Prover Engine
    participant Wallet as Wallet
    participant ProofRegistry as ProofRegistry
    participant IssuerRegistry as IssuerRegistry
    participant Verifier as CredentialVerifier
    
    Holder->>Browser: Request Proof Generation
    Browser->>Prover: Load Credential (value, salt, commitment, signature, issuer pubkey)
    Prover->>Prover: Load Noir Circuit
    Prover->>Prover: Generate Witness
    Prover->>Prover: Generate UltraHonk Proof
    Prover-->>Browser: Return Proof + Public Inputs
    Browser->>Wallet: Prepare submit_proof Transaction
    Wallet->>ProofRegistry: submit_proof(holder, issuer_id, credential_type, proof, public_inputs, expiry)
    ProofRegistry->>IssuerRegistry: is_valid_issuer(issuer_id, credential_type)
    IssuerRegistry-->>ProofRegistry: true/false
    ProofRegistry->>ProofRegistry: Check Public Key in Public Inputs Matches Registered Key
    ProofRegistry->>Verifier: verify_proof(credential_type, proof, public_inputs)
    Verifier-->>ProofRegistry: true/false
    ProofRegistry->>ProofRegistry: Cache Proof Record (is_verified = true)
    ProofRegistry-->>Wallet: Transaction Success
    Wallet-->>Browser: Proof Submitted
```

## Consuming Protocols Flow

This sequence diagram shows how third-party protocols (dApps) consume verified credentials by checking the ProofRegistry.

```mermaid
sequenceDiagram
    autonumber
    participant User as User
    participant DApp as Protocol dApp
    participant SDK as @stellarcred/sdk
    participant ProofRegistry as ProofRegistry
    
    User->>DApp: Attempt to Access Gated Feature
    DApp->>SDK: hasClaim(wallet, credential_type, min_threshold?)
    SDK->>ProofRegistry: check_claim(holder, credential_type, min_threshold) OR is_verified(holder, credential_type)
    ProofRegistry-->>SDK: true/false
    SDK-->>DApp: true/false
    alt Claim Verified
        DApp->>User: Grant Access
    else Claim Not Verified
        DApp->>User: Deny Access (Show Verify Button)
        User->>DApp: Click Verify
        DApp->>SDK: buildVerifyUrl(returnUrl, claim)
        SDK-->>DApp: StellarCred Verify URL
        DApp->>User: Redirect to StellarCred
    end
```
