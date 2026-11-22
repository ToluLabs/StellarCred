# Backup and Restore Guide for Credential Data and Export Bundles

Credential exports and backup data contain sensitive information. This guide describes a single, repeatable workflow to export, archive, and restore that data safely. It covers encryption, retention, and integrity verification so a contributor or operator can recover from data corruption or accidental deletion without guesswork.

> WARNING: Export bundles contain secrets (credentials, tokens, keys). Treat them as production secrets at all times. Never commit them to version control, paste them into issues, chat, or share them over unencrypted channels.

## Prerequisites and Scope

- A working installation of this repository with its export tooling available.
- Access to the credential store you intend to back up.
- A secure, encrypted destination for archives (e.g. an encrypted volume or secrets manager).
- A recovery passphrase stored in your password manager or secrets manager — not in the same location as the archive.

This guide assumes the repository's export tooling produces a single bundle file (e.g. a JSON or tar archive) that can be re-imported into a known-good environment. Adjust the command names below to match the export tooling shipped in your checkout (consult [docs/EXPORTS.md](EXPORTS.md) for the canonical command surface).

## Export and Archive Credential Bundles

### 1. Prepare a clean export environment

Export from a known-good installation and avoid running the export on a machine with untrusted processes. Confirm the export tool version so the bundle format is documented alongside the archive.

```bash
# Record tool version for the archive manifest
your-export-tool --version > export-version.txt

```

### 2. Export the bundle

Run the export command and write the bundle to a private directory with restrictive permissions.

```bash
umask 077
mkdir -p ./backups
your-export-tool export --out ./backups/credentials-$(date +UY%-m%d).bundle
```

If the tooling supports an encryption flag, protect the bundle at export time:

```bash
your-export-tool export --out ./backups/credentials-$(date +UY%-m%d).bundle --encrypt
```

### 3. Encrypt at rest

If the export tooling does not encrypt itself, encrypt the bundle before it leaves the host. Use a standard authenticated encryption tool and a strong passphrase.

```bash
gpg --symmetric --cipher AES256 --output ./backups/credentials.bundle.gpg ./backups/credentials.bundle
shred /u ./backups/credentials.bundle
```

### 4. Record an integrity manifest

Store a hash of the archive alongside it so a restore can be verified. Hash the encrypted file as well as the plaintext bundle if you keep both.

```bash
sha256 sum ./backups/credentials.bundle.gpg > ./backups/credentials.bundle.gpg.sha256
```

### 5. Archive safely

- Move the encrypted bundle and its manifest to the encrypted destination.
- Delete any plaintext bundle from the working directory once the encrypted copy is confirmed.
- Record the export date, tool version, and retention deadline in your operations log.

```bash
rm -f ./backups/credentials.bundle
```

## Restore Procedure

Restore into a known-good environment. Do not restore into a live production instance without a rollback plan.

### 1. Prepare the target environment

- Provision a clean installation of the repository at the same or a known-compatible version as the export.
- Confirm the export tool version matches the version recorded in the archive manifest.
- Ensure the target has no conflicting credential entries; restore into an empty or isolated store.

### 2. Verify archive integrity

Compare the received file against the recorded hash before decrypting.

```bash
sha256sum -c ./backups/credentials.bundle.gpg.sha256
```

If the checksum does not match, do not continue. Request a fresh copy from the archive source.

### 3. Decrypt the bundle

```bash
gpg --output ./restore/credentials.bundle --decrypt ./backups/credentials.bundle.gpg
```

Verify the decrypted bundle against the plaintext hash if one was recorded.

### 4. Import into the target

Run the import command in dry-run mode first if supported, then perform the real import.

```bash
your-export-tool import --in ./restore/credentials.bundle --dry-run
your-export-tool import --in ./restore/credentials.bundle
```

### 5. Verify the restore

- Confirm the import reports the expected number of entries.
- Spot-check a sample of credentials against the source of truth.
- Run the repository's validation or smoke tests against the restored store.
- Record the restore timestamp, bundle hash, and operator in the operations log.

### 6. Clean up

Remove the decrypted bundle from the working directory once the restore is verified.

```bash
shred /u ./restore/credentials.bundle
rm -f ./restore/credentials.bundle
```

## Security Guidance

### Encryption

- Always encrypt bundles at rest. Prefer the export tool's built-in encryption when available; otherwise use a standard authenticated encryption tool such as GPG with AES256.
- Store the recovery passphrase in a password manager or secrets manager, separate from the archive.
- Never transmit bundles over unencrypted channels or attach them to tickets and chat messages.

### Retention

- Define a retention window (for example, 30/90/365 days) and rotate archives accordingly.
- Delete expired archives securely and record the deletion in the operations log.
- Keep at least one offsite copy in an encrypted location that is independent of the primary environment.

### Verifying Restore Integrity

- Always compare the archive hash before decrypting and the plaintext hash before importing.
- Perform a dry-run import when the tooling supports it.
- Run smoke tests against the restored store before switching traffic or dependencies to it.
- Record every restore in the operations log with the bundle hash and operator identity.

## Related Documentation

- [docs/EXPORTS.md](EXPORTS.md) — export bundle formats and command reference.
- [README.md](../README#backup-and-restore) — quick pointer to this guide.
