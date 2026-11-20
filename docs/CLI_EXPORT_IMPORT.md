# Credential JSON CLI

The CLI validates and copies plaintext credential JSON files using the same
credential parser as the app. It does not connect to a browser store or modify
credentials.

Install the frontend dependencies, then run either command from the repository
root:

```sh
pnpm --dir frontend install
pnpm --dir frontend credential:cli -- export ./credentials.json ./backup.json
pnpm --dir frontend credential:cli -- import ./backup.json ./restored.json
```

Both input formats are supported: one credential object or an array of
credentials. The output remains in the app's plaintext JSON format and
preserves each credential's fields. To restore credentials into the browser,
open the holder page and import the resulting JSON file there.

Encrypted backup envelopes are intentionally not decrypted by this CLI. Use
the app's backup-import flow and its passphrase for those files. The `export`
and `import` command names make the direction of the file transfer explicit;
both operations validate the source before writing a new destination file, and
will not overwrite an existing destination.

## Security

Plaintext credential exports contain sensitive credential material, including
the committed attribute value and salt. Treat them like passwords: keep them
out of source control and shared logs, use restrictive file permissions, and
delete temporary copies securely when they are no longer needed. This helper
does not encrypt exports.
