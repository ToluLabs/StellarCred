# Export Bundles and Supported Data Models

This document describes the export bundles produced by the repository's export tooling and the data models that a restore must accept. For the end-to-end backup and restore workflow, see [BACKUP_RESTORE.md](BACKUP_RESTORE.md).

## Overview

An export bundle is a self-contained representation of credential data produced by the export tooling. Bundles are intended for backup and migration and contain sensitive material.

Every bundle has two top-level concerns:

1. **Envelope metadata** - format version, schema version, export timestamp, and the application version that produced the bundle.
2. **Records** - the credential records themselves.

## Bundle format

Bundles are JSON documents with the following shape:

```json
{
  "format_version": 1,
  "schema_version": 1,
  "exported_at": "2024-01-01T00:00:00Z",
  "app_version": "0.0.0",
  "records": [
    {
      "id": "<opaque-id>",
      "type": "credential",
      "name": "<label>",
      "secret_reference": "<opaque-reference>",
      "metadata": {}
    }
  ]
}
```

Field descriptions:

| Field             | Type   | Description                                                     |
| ------------------ | ------ | ---------------------------------------------------------------------- |
| `format_version`  | integer | Version of the bundle enclosure format.                                    |
| `schema_version`  | integer | Version of the record schema.                                              |
| `exported_at`     | string  | ISO 8601 timestamp of when the bundle was produced.                         |
| `app_version`     | string  | Application version that produced the bundle.                               |
| `records`         | array  | List of credential records.                                                 |

## Supported data models

The export tooling supports the following data models. A bundle whose `schema_version` is not listed here must be rejected by the importer.

| Data model     | `schema_version` | Notes                                                     |
| --------------- | ---------------- | ----------------------------------------------------------------------- |
| `credential`     | 1                  | Credential records with opaque secret references.                        |

## Export workflow

1. Select the data set to export.
2. Produce the bundle with the repository export tooling.
3. Restrict permissions on the output file (`600`).
4. Record the checksum of the bundle for verification during restore.

See [BACKUP_RESTORE.md](BACKUP_RESTORE.md) for the full export, archive, and restore procedure.

## Import requirements

An importer must:

1. Validate the bundle against the envelope format above.
2. Reject bundles with an unsupported `format_version` or `schema_version`.
3. Preserve the original `exported_at` and `app_version` values for auditing.
4. Report the number of records imported and any records rejected.

## Security notes

- Bundles contain sensitive material. Encrypt them at rest and in transit.
- Never commit bundles to version control.
- Delete plaintext bundles after encrypting or after a verified restore.
