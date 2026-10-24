# Offline Credential Export/Import CLI Helper

This document describes the offline credential export/import command-line interface helper ([#811](https://github.com/ToluLabs/StellarCred/issues/811)). It covers supported formats, installation, command usage, automated workflows (recovery, migration, CI), and essential security guidance for handling credential files.

---

## 1. Overview & Motivation

In StellarCred, credential holders normally export and import JSON backup files directly through the browser UI (on the Holder page). However, relying exclusively on the browser poses challenges:

- **Emergency Disaster Recovery:** If a user loses browser access, local storage is cleared, or the web frontend is unavailable, holders need an auditable, offline script to inspect, decrypt, and restore credential data.
- **Bulk Migration:** Enterprise operators, testing teams, and CI systems need to migrate or seed credentials across environments without manual browser clicks.
- **CI Test Fixtures & Demos:** Continuous integration test pipelines require reproducible, scriptable credential import and validation utilities.

The `credential-cli` helper provides a lightweight, script-driven tool written in TypeScript running natively on Node.js without third-party runtime dependencies.

---

## 2. Supported Formats & Architecture

The CLI is designed for full bidirectional compatibility with the StellarCred frontend:

### A. Plain Credential Array (Default Web App Export)
This format matches the JSON exported by the web app's `downloadBackup()` and `exportCredentials()` (`frontend/lib/credential.ts`):

```json
[
  {
    "type": "kyc",
    "title": "KYC Complete",
    "claim": "identity verified",
    "issuer": "Onfido",
    "issuerId": "0xissuer123...",
    "holder": "GBZXN7PIRZGNMHGA7282KKLG...",
    "value": "1",
    "salt": "0x1a2b3c4d5e6f7a8b9c0d1e2f...",
    "commitment": "0x0987654321fedcba0987654321fedcba...",
    "sig": [7, 7, 7, ...],
    "issuerPubX": [8, 8, ...],
    "issuerPubY": [9, 9, ...],
    "issuedAt": 1700000000,
    "expiry": "90 days",
    "deployment": {
      "network": "testnet",
      "contractId": "CA3D5K..."
    },
    "circuitVersion": "v1.0.0",
    "circuitVkVersion": 1
  }
]
```

### B. Encrypted Backup Envelope (v3 Sealed Envelope)
Matches `EncryptedBackup` from `frontend/lib/backup.ts` and `frontend/lib/credential-crypto.ts`. Sealed with AES-256-GCM and a key derived via PBKDF2-SHA256 with **600,000 iterations** (OWASP 2023+ standard):

```json
{
  "version": 3,
  "kdf": "PBKDF2-SHA256",
  "iterations": 600000,
  "salt": "u8v... (base64url)",
  "iv": "3xq... (base64url)",
  "ciphertext": "k9L... (base64url)",
  "deployment": {
    "network": "testnet",
    "contractId": "CA3D5K..."
  }
}
```

The CLI also maintains read compatibility with legacy version 1 (100,000 PBKDF2 iterations) and version 2 envelopes.

### C. Versioned Metadata Envelope
When exported with `--envelope`, credentials are wrapped in an auditable metadata envelope:

```json
{
  "version": 1,
  "exportedAt": "2026-10-21T12:00:00.000Z",
  "generator": "credential-cli",
  "count": 2,
  "credentials": [ ... ]
}
```

### D. Single Credential Object
Direct JSON objects representing a single credential (as used in the app's `ImportPanel` text input) are supported on import.

---

## 3. Structural Invariants & Non-Alteration

The CLI enforces strict non-alteration guarantees:
1. **Preserved Cryptographic Values:** The unblinded BN254 scalar string representations (`value`, `salt`, `commitment`), signature byte arrays (`sig`: 64 bytes), and public key byte arrays (`issuerPubX`, `issuerPubY`: 32 bytes each) are copied verbatim without floating-point conversion, truncation, or re-encoding.
2. **Metadata Retention:** Fields such as `deployment`, `circuitVersion`, `circuitVkVersion`, `provedAt`, `provedTxHash`, and `seniority` remain intact.
3. **Boundary Validation:** Every credential passing through the CLI is checked against field scalar patterns and byte constraints, ensuring corrupted records are caught before writing.

---

## 4. Running the CLI

### Using npm Scripts
Scripts are configured in both the repository root and `frontend/package.json`:

```bash
# In repository root:
npm run credential-cli -- <command> [options]
npm run credentials:export -- [options]
npm run credentials:import -- [options]
npm run credentials:validate -- [options]
npm run credentials:inspect -- [options]

# In frontend directory:
npm run credential-cli -- <command> [options]
```

### Direct Invocation with Node
The CLI runs directly with Node (v20+ / v24+):

```bash
node --no-warnings --experimental-strip-types scripts/credential-cli.ts <command> [options]
```

---

## 5. Command Reference

### `export`
Exports credentials from an existing credentials store or JSON file to a backup file.

```bash
credential-cli export -i <input-file> -o <output-file> [options]
```

| Flag | Short | Description |
|---|---|---|
| `--input <path>` | `-i` | Source credential or backup JSON file |
| `--output <path>` | `-o` | Destination backup file |
| `--format <plain\|encrypted>` | `-f` | Output format (`plain` default; `encrypted` when passphrase is provided) |
| `--passphrase <pass>` | `-p` | Passphrase for AES-256-GCM encryption (or env `CREDENTIAL_PASSPHRASE`) |
| `--type <types>` | `-t` | Comma-separated credential types to filter (e.g. `kyc,age`) |
| `--holder <address>` | | Filter credentials by Stellar holder address |
| `--envelope` | | Wrap plain JSON in a versioned metadata envelope |
| `--no-pretty` | | Emit compact JSON instead of 2-space indented JSON |
| `--force` | | Overwrite existing output file |

**Examples:**
```bash
# Export plain backup for browser import:
npm run credentials:export -- -i credentials.json -o stellarcred-backup.json

# Export encrypted backup for secure off-site archive:
npm run credentials:export -- -i credentials.json -o backup.enc.json -p "MyStrongPassphrase!2026"

# Export only KYC credentials for an identity check demo:
npm run credentials:export -- -i credentials.json -o kyc-only.json -t kyc
```

---

### `import`
Imports a credential backup file (plain array, envelope, or encrypted file) and converts/saves it into an app-compatible JSON file.

```bash
credential-cli import -i <input-file> -o <output-file> [options]
```

| Flag | Short | Description |
|---|---|---|
| `--input <path>` | `-i` | Backup file to import |
| `--output <path>` | `-o` | Destination JSON file |
| `--passphrase <pass>` | `-p` | Passphrase if input is encrypted (or env `CREDENTIAL_PASSPHRASE`) |
| `--merge` | `-m` | Merge with existing destination file, deduplicating by `type` + `commitment` |
| `--filter-type <types>` | `-t` | Import only specified credential types (e.g. `age,employment`) |
| `--dry-run` | | Parse, validate, and report without writing any files |
| `--force` | | Overwrite destination file if not merging |

**Examples:**
```bash
# Restore credentials from an exported browser backup:
npm run credentials:import -- -i stellarcred-backup.json -o credentials.json --force

# Decrypt and restore an encrypted backup:
npm run credentials:import -- -i backup.enc.json -o credentials.json -p "MyStrongPassphrase!2026"

# Merge new credentials into an existing store without deleting previous entries:
npm run credentials:import -- -i new-creds.json -o credentials.json --merge

# Dry run verification of a backup artifact:
npm run credentials:import -- -i backup.json -o credentials.json --dry-run
```

---

### `validate`
Inspects and validates credential structures offline.

```bash
credential-cli validate -i <input-file> [-p <passphrase>]
```

- Verifies that `type`, `value`, `salt`, `commitment`, `issuerId`, `holder`, and `expiry` conform to protocol schema.
- Confirms signature length is exactly 64 bytes and public keys are 32 bytes each.
- Returns exit code `0` on success and `1` on error.

```bash
npm run credentials:validate -- -i backup.json
```

---

### `inspect`
Displays a structured overview of all credentials in a backup file.

```bash
credential-cli inspect -i <input-file> [-p <passphrase>] [--show-sensitive]
```

By default, private cryptographic components (`salt`, unblinded `value`, signature bytes) are **redacted** to protect confidential personal information. Pass `--show-sensitive` only in secure offline diagnostics.

```bash
npm run credentials:inspect -- -i backup.json
```

Output:
```
[Inspect] File: backup.json
[Inspect] Format: Plain JSON
[Inspect] Total credentials: 1
────────────────────────────────────────────────────────────────────────
[#1] Type: kyc | Title: KYC Complete | Claim: identity verified
     Issuer: Test Issuer (issuer-123)
     Holder: GBZXN7PIRZGNMHGA7282KKLG
     Expiry: 90 days | IssuedAt: 2023-11-14T22:13:20.000Z
     Commitment: 0x09876543...fedcba
     Deployment: testnet
     [SENSITIVE] Salt & Value: <redacted - use --show-sensitive to view>
────────────────────────────────────────────────────────────────────────
```

---

## 6. Common Workflows

### Workflow 1: Emergency Browser Disaster Recovery
If local storage is cleared or a device is lost:
1. Locate your exported `stellarcred-backup-YYYY-MM-DD.json` or encrypted backup `backup.enc.json`.
2. Inspect the file offline to verify contents:
   ```bash
   npm run credentials:inspect -- -i backup.enc.json -p "MySecretPassphrase"
   ```
3. Import the decrypted credentials into your target working directory:
   ```bash
   npm run credentials:import -- -i backup.enc.json -o restored-credentials.json -p "MySecretPassphrase"
   ```
4. Copy the restored JSON array into the browser app's Holder page import panel.

### Workflow 2: CI Test Suite Fixture Migration
To prepare test credentials for automated tests:
```bash
# Filter test credentials and generate clean test fixture:
npm run credentials:export -- -i fixtures/all-credentials.json -o fixtures/testnet-kyc.json -t kyc --force
```

### Workflow 3: Deduplicating and Merging Backups
To combine credentials from multiple devices or sessions into a single store:
```bash
npm run credentials:import -- -i laptop-backup.json -o primary-store.json --merge
npm run credentials:import -- -i mobile-backup.json -o primary-store.json --merge
```

---

## 7. Security Guidance & Threat Model

Credentials in StellarCred enable zero-knowledge proofs of sensitive claims (identity, accredited investor status, age, employment). The plaintext credential JSON contains confidential elements that must be protected:

> [!CAUTION]
> **Treat Plaintext Credential JSON as Private Key Material:**
> A credential JSON contains the unblinded `salt` and `value`. Anyone with access to this plaintext file can link the commitment on-chain, deanonymize the credential holder, or generate proofs on the holder's behalf.

### Security Best Practices
1. **Never Commit Backups to Version Control:**
   Ensure `*.json` backups and exports are in `.gitignore` or kept outside repository checkouts.
2. **Restrict File Permissions:**
   On Unix/Linux/macOS systems, restrict file access immediately after export:
   ```bash
   chmod 600 credentials.json
   ```
3. **Prefer Encrypted Exports for Storage:**
   Always use `--format encrypted` with a strong passphrase (`-p`) whenever backups are saved to external drives, USB storage, or cloud backup folders.
4. **Environment Variable for Passphrases:**
   Avoid passing plain-text passphrases in shell history by using the `CREDENTIAL_PASSPHRASE` environment variable:
   ```bash
   export CREDENTIAL_PASSPHRASE="your-passphrase-here"
   npm run credentials:export -- -i creds.json -o backup.enc.json
   ```
5. **Secure Deletion:**
   When using plain JSON files for temporary migration or debugging, permanently erase them after recovery using `shred` or secure deletion tools.
