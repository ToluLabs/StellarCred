/**
 * Versioned export artifact schema (#780).
 *
 * Proof-history exports moved from the flat, unversioned shape produced by
 * lib/export-history.ts (`{ exportedAt, entries }`) to a versioned artifact
 * that carries generation metadata so a downstream reader can tell *when* a
 * file was produced, *by what*, and *from which legacy format* it was
 * backfilled — the same forward-compatibility discipline the ProofRecord
 * on-chain schema (`PROOF_RECORD_SCHEMA_VERSION`) and the credential envelope
 * (`credential-crypto.ts`) already follow.
 *
 * `schemaVersion` is only ever added to; an existing version is never
 * reinterpreted. Bump it and add a migration when the entry layout changes.
 *
 * Integrity: every v1 artifact carries a SHA-256 checksum over a canonical
 * serialization of `{ schemaVersion, generation, count, entries }`. Import
 * recomputes the checksum and rejects mismatched or corrupt bundles before
 * any data is applied. The checksum detects accidental corruption and naive
 * tampering; it is not a signature and does not authenticate the producer.
 *
 * This module is pure (no DOM/localStorage, no filesystem) so it can run in
 * the browser, under vitest, and inside the Node backfill CLI.
 */

/** Current export artifact schema version. New writes always use this value. */
export const EXPORT_SCHEMA_VERSION = 1;

/** Algorithm used for the artifact integrity checksum. */
export const EXPORT_INTEGRITY_ALGORITHM = "SHA-256";

/** Integrity metadata embedded alongside the artifact payload. */
export interface IntegrityMetadata {
  algorithm: typeof EXPORT_INTEGRITY_ALGORITHM;
  /** Lowercase hex digest of the canonical payload (see `canonicalPayload`). */
  checksum: string;
}

/** Identifies the legacy file a backfilled artifact was read from. */
export type SourceFormat = "legacy-json" | "legacy-csv";

/**
 * A single verified-credential record. Mirrors `ProofHistoryEntry` from
 * lib/export-history.ts so a backfilled artifact round-trips the legacy data
 * without loss; `source` marks where the entry came from within the legacy
 * file (proof timeline vs. submission log) — legacy entries leave it unset.
 */
export interface ExportEntry {
  claimType: string;
  /** Unix seconds when the proof was verified on-chain. */
  verifiedAt: number;
  /** Unix seconds when the credential expires; 0 when unknown/not tracked. */
  expiry: number;
  /** On-chain transaction hash; "" for submission-log-only entries. */
  txHash: string;
  /** Issuer contract id; "" when unknown. */
  issuer: string;
  source?: string;
}

/** Metadata describing how an artifact was generated. */
export interface GenerationMetadata {
  /** ISO-8601 timestamp of when this artifact was produced. */
  generatedAt: string;
  /** Name/version of the producer (e.g. "backfill-export", the UI exporter). */
  generator: string;
  /** Source format a backfill read from; omitted for freshly-captured exports. */
  sourceFormat?: SourceFormat;
  /** Legacy `exportedAt` from the source file, preserved for provenance. */
  sourceExportedAt?: string;
}

/** The versioned export artifact. This is what the new pipeline emits. */
export interface ExportArtifactV1 {
  schemaVersion: 1;
  generation: GenerationMetadata;
  /** Optional for backward compatibility with pre-checksum artifacts. */
  integrity?: IntegrityMetadata;
  /** Number of entries carried in `entries` after safety validation. */
  count: number;
  entries: ExportEntry[];
}

/** Outcome of a backfill run — reported in both dry-run and real runs. */
export interface BackfillReport {
  sourceFormat: SourceFormat;
  /** Entries read from the legacy file before validation. */
  inputCount: number;
  /** Entries that passed validation and landed in the artifact. */
  outputCount: number;
  /** 1-based line/entry numbers of rejected entries with a reason. */
  skipped: Array<{ index: number; reason: string }>;
}

/** Raised for structurally unreadable input (not per-entry validation). */
export class LegacyExportError extends Error {}

/** Raised when an artifact fails integrity verification on import. */
export class ArtifactIntegrityError extends Error {}

// ── Integrity ───────────────────────────────────────────────────────────────

/**
 * Canonical serialization of the signed portion of an artifact. Keys are
 * emitted in a fixed order so the same logical content always hashes the same
 * regardless of object key insertion order.
 */
export function canonicalPayload(artifact: {
  schemaVersion: number;
  generation: GenerationMetadata;
  count: number;
  entries: ExportEntry[];
}): string {
  const gen = artifact.generation;
  const generation: Record<string, unknown> = {
    generatedAt: gen.generatedAt,
    generator: gen.generator,
  };
  if (gen.sourceFormat !== undefined) generation.sourceFormat = gen.sourceFormat;
  if (gen.sourceExportedAt !== undefined) {
    generation.sourceExportedAt = gen.sourceExportedAt;
  }
  const entries = artifact.entries.map((e) => {
    const out: Record<string, unknown> = {
      claimType: e.claimType,
      verifiedAt: e.verifiedAt,
      expiry: e.expiry,
      txHash: e.txHash,
      issuer: e.issuer,
    };
    if (e.source !== undefined) out.source = e.source;
    return out;
  });
  return JSON.stringify({
    schemaVersion: artifact.schemaVersion,
    generation,
    count: artifact.count,
    entries,
  });
}

/** Lowercase hex SHA-256 of a UTF-8 string. Uses Web Crypto (browser + Node 19+). */
export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Compute the integrity metadata for an artifact's signed payload. */
export async function computeIntegrity(artifact: {
  schemaVersion: number;
  generation: GenerationMetadata;
  count: number;
  entries: ExportEntry[];
}): Promise<IntegrityMetadata> {
  return {
    algorithm: EXPORT_INTEGRITY_ALGORITHM,
    checksum: await sha256Hex(canonicalPayload(artifact)),
  };
}

/**
 * Attach integrity metadata to a freshly built artifact. The returned artifact
 * is the one that should be serialized and written to disk.
 */
export async function sealArtifact(artifact: ExportArtifactV1): Promise<ExportArtifactV1> {
  const integrity = await computeIntegrity(artifact);
  return { ...artifact, integrity };
}

/**
 * Verify an artifact before import. Rejects (throws `ArtifactIntegrityError`)
 * with an actionable message when:
 *   - the schema version is unknown or unsupported,
 *   - `count` does not match the number of entries (truncation/edit),
 *   - the checksum algorithm is unsupported,
 *   - the recomputed checksum does not match (corruption or tampering).
 *
 * Artifacts without `integrity` (pre-checksum) are accepted only when
 * `allowUnsigned` is true; otherwise they are rejected so unverifiable data
 * is never silently applied.
 */
export async function verifyArtifact(
  raw: unknown,
  options: { allowUnsigned?: boolean } = {}
): Promise<ExportArtifactV1> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ArtifactIntegrityError(
      "The file is not a valid export bundle (expected a JSON object). Re-export and try again."
    );
  }
  const obj = raw as Record<string, unknown>;

  if (obj["schemaVersion"] !== EXPORT_SCHEMA_VERSION) {
    throw new ArtifactIntegrityError(
      `Unsupported export schema version ${String(obj["schemaVersion"])}. ` +
        `This app reads version ${EXPORT_SCHEMA_VERSION}; upgrade the app or re-export from a matching version.`
    );
  }

  const generation = obj["generation"];
  if (typeof generation !== "object" || generation === null) {
    throw new ArtifactIntegrityError(
      "The export bundle is missing its generation metadata. The file may be damaged."
    );
  }
  const gen = generation as Record<string, unknown>;
  if (typeof gen["generatedAt"] !== "string" || typeof gen["generator"] !== "string") {
    throw new ArtifactIntegrityError(
      "The export bundle's generation metadata is malformed. The file may be damaged."
    );
  }

  const entries = obj["entries"];
  if (!Array.isArray(entries)) {
    throw new ArtifactIntegrityError(
      "The export bundle has no entries list. The file may be truncated."
    );
  }
  if (obj["count"] !== entries.length) {
    throw new ArtifactIntegrityError(
      `The export bundle claims ${String(obj["count"])} entries but contains ${entries.length}. ` +
        "The file was likely truncated or edited after export."
    );
  }

  const integrity = obj["integrity"];
  if (integrity === undefined) {
    if (options.allowUnsigned) {
      return raw as ExportArtifactV1;
    }
    throw new ArtifactIntegrityError(
      "This export has no integrity checksum, so it cannot be verified. " +
        "Re-export it with the current app, or import it explicitly as an unverified legacy file."
    );
  }
  if (typeof integrity !== "object" || integrity === null) {
    throw new ArtifactIntegrityError("The export's integrity metadata is malformed.");
  }
  const meta = integrity as Record<string, unknown>;
  if (meta["algorithm"] !== EXPORT_INTEGRITY_ALGORITHM) {
    throw new ArtifactIntegrityError(
      `Unsupported integrity algorithm "${String(meta["algorithm"])}". Expected ${EXPORT_INTEGRITY_ALGORITHM}.`
    );
  }
  if (typeof meta["checksum"] !== "string") {
    throw new ArtifactIntegrityError("The export's integrity checksum is missing.");
  }

  const artifact = raw as ExportArtifactV1;
  const actual = await computeIntegrity(artifact);
  if (actual.checksum !== meta["checksum"]) {
    throw new ArtifactIntegrityError(
      "The export failed its integrity check: the contents do not match the recorded checksum. " +
        "The file was corrupted or modified after export, so it has not been imported. " +
        "Restore from an original, unmodified export."
    );
  }
  return artifact;
}

// ── Legacy parsing ──────────────────────────────────────────────────────────

function asRecord(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new LegacyExportError(`${where} must be an object`);
  }
  return value as Record<string, unknown>;
}

/**
 * Parse the legacy JSON export produced by `exportHistoryAsJson` —
 * `{ exportedAt: string, entries: ProofHistoryEntry[] }`.
 */
export function parseLegacyJson(text: string): {
  exportedAt: string;
  entries: ExportEntry[];
} {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new LegacyExportError(`input is not valid JSON (${(e as Error).message})`);
  }
  const obj = asRecord(raw, "legacy export");
  if (typeof obj["exportedAt"] !== "string") {
    throw new LegacyExportError('legacy export is missing an "exportedAt" string');
  }
  if (!Array.isArray(obj["entries"])) {
    throw new LegacyExportError('legacy export is missing an "entries" array');
  }
  const entries = obj["entries"].map((item, i) =>
    legacyEntryFromObject(asRecord(item, `entries[${i}]`), i)
  );
  return { exportedAt: obj["exportedAt"], entries };
}

function legacyEntryFromObject(
  obj: Record<string, unknown>,
  index: number
): ExportEntry {
  return {
    claimType: typeof obj["claimType"] === "string" ? obj["claimType"] : "",
    verifiedAt: numberField(obj["verifiedAt"], `entries[${index}].verifiedAt`),
    expiry: numberField(obj["expiry"], `entries[${index}].expiry`),
    txHash: typeof obj["txHash"] === "string" ? obj["txHash"] : "",
    issuer: typeof obj["issuer"] === "string" ? obj["issuer"] : "",
  };
}

function numberField(value: unknown, where: string): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  throw new LegacyExportError(`${where} must be a finite number`);
}

// The legacy CSV (`exportHistoryAsCsv`) uses ISO timestamps for verified_at /
// expiry and empty expiry for "unknown". Split one physical record into fields,
// honouring the same double-quote escaping the writer uses.

/** Read a full CSV record starting at `start`, consuming any quoted newlines. */
function readCsvRecord(text: string, start: number): { fields: string[]; next: number } {
  const fields: string[] = [];
  let field = "";
  let inQuotes = false;
  // Tracks whether the current physical line has begun, so a lone "\n" between
  // records is skipped rather than emitted as an empty field.
  let touched = false;

  const push = () => {
    fields.push(field);
    field = "";
    touched = true;
  };

  let i = start;
  for (; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    // A quote opens a field only when nothing has been added to it yet.
    if (ch === '"' && field === "") {
      inQuotes = true;
      touched = true;
      continue;
    }
    if (ch === ",") {
      push();
      continue;
    }
    if (ch === "\n") {
      if (touched) push();
      return { fields, next: i + 1 };
    }
    if (ch === "\r") {
      continue;
    }
    field += ch;
  }
  if (touched) push();
  return { fields, next: i };
}

function unescapeCsvInt(value: string): number {
  const trimmed = value.trim();
  if (trimmed === "") return 0;
  // Pure numbers (unix seconds) must never go through Date.parse — "0" is a
  // valid year in V8's lenient parser and would otherwise become a timestamp.
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) {
    const asNumber = Number(trimmed);
    return Number.isFinite(asNumber) ? asNumber : NaN;
  }
  const iso = Date.parse(trimmed);
  return Number.isNaN(iso) ? NaN : Math.floor(iso / 1000);
}

/**
 * Parse the legacy CSV export produced by `exportHistoryAsCsv`. Recognises the
 * header row `claim_type,verified_at,expiry,tx_hash,issuer`.
 */
export function parseLegacyCsv(text: string): {
  exportedAt: string | undefined;
  entries: ExportEntry[];
} {
  const records: string[][] = [];
  let pos = 0;
  while (pos < text.length) {
    const { fields, next } = readCsvRecord(text, pos);
    pos = next;
    if (fields.length === 0) continue; // blank line
    if (fields.length === 1 && fields[0] === "") continue;
    records.push(fields);
  }
  if (records.length === 0) return { exportedAt: undefined, entries: [] };

  const header = records[0].map((h) => h.trim().toLowerCase());
  const isHeader = header.includes("claim_type");
  const rows = isHeader ? records.slice(1) : records;

  const idx = (name: string, fallback: number) => {
    const at = header.indexOf(name);
    return at === -1 ? fallback : at;
  };
  const cType = idx("claim_type", 0);
  const cVerified = idx("verified_at", 1);
  const cExpiry = idx("expiry", 2);
  const cTx = idx("tx_hash", 3);
  const cIssuer = idx("issuer", 4);

  const entries = rows.map((fields, i) => {
    const verifiedAt = unescapeCsvInt(fields[cVerified] ?? "");
    if (Number.isNaN(verifiedAt)) {
      throw new LegacyExportError(`row ${i + 1}: unparseable verified_at`);
    }
    const expiry = unescapeCsvInt(fields[cExpiry] ?? "");
    return {
      claimType: (fields[cType] ?? "").trim(),
      verifiedAt,
      expiry: Number.isNaN(expiry) ? 0 : expiry,
      txHash: (fields[cTx] ?? "").trim(),
      issuer: (fields[cIssuer] ?? "").trim(),
    };
  });
  return { exportedAt: undefined, entries };
}

/** Dispatch on file extension or content sniff to the right legacy parser. */
export function parseLegacyExport(
  text: string,
  hint: SourceFormat
): { exportedAt: string | undefined; entries: ExportEntry[] } {
  return hint === "legacy-json" ? parseLegacyJson(text) : parseLegacyCsv(text);
}

// ── Safety validation ─────────────────────────────────────────────────────

/**
 * Validate one entry against the v1 contract. Returns an error string or
 * null when the entry is safe to carry into the artifact. Never trusts a
 * legacy value blindly — a corrupt file must not poison the new pipeline.
 */
export function validateEntry(entry: ExportEntry): string | null {
  if (entry.claimType.trim() === "") return "claimType is empty";
  if (!Number.isInteger(entry.verifiedAt) || entry.verifiedAt < 0) {
    return "verifiedAt must be a non-negative integer";
  }
  if (!Number.isInteger(entry.expiry) || entry.expiry < 0) {
    return "expiry must be a non-negative integer (0 = unknown)";
  }
  // expiry === 0 means "unknown/untracked" and is allowed on its own.
  if (entry.expiry !== 0 && entry.expiry < entry.verifiedAt) {
    return "expiry is before verifiedAt";
  }
  if (typeof entry.txHash !== "string") return "txHash must be a string";
  return null;
}

// ── Backfill conversion ───────────────────────────────────────────────────

export interface BackfillOptions {
  generator: string;
  sourceFormat: SourceFormat;
  sourceExportedAt?: string;
  /** Injectable clock so dry-run output is deterministic under test. */
  now?: () => Date;
}

/**
 * Convert legacy entries into a schema v1 artifact plus a run report. Entries
 * failing validation are skipped and recorded, not silently dropped or thrown
 * — this is the shared core of the real backfill and its dry-run.
 *
 * The returned artifact is unsealed; call `sealArtifact` before writing it so
 * the bundle carries integrity metadata.
 */
export function planBackfill(
  legacyEntries: ExportEntry[],
  options: BackfillOptions
): { artifact: ExportArtifactV1; report: BackfillReport } {
  const now = (options.now ? options.now() : new Date()).toISOString();
  const kept: ExportEntry[] = [];
  const skipped: BackfillReport["skipped"] = [];

  legacyEntries.forEach((entry, i) => {
    const error = validateEntry(entry);
    if (error) {
      skipped.push({ index: i + 1, reason: error });
    } else {
      kept.push(entry);
    }
  });

  const generation: GenerationMetadata = {
    generatedAt: now,
    generator: options.generator,
    sourceFormat: options.sourceFormat,
  };
  if (options.sourceExportedAt) {
    generation.sourceExportedAt = options.sourceExportedAt;
  }

  const artifact: ExportArtifactV1 = {
    schemaVersion: EXPORT_SCHEMA_VERSION,
    generation,
    count: kept.length,
    entries: kept,
  };

  const report: BackfillReport = {
    sourceFormat: options.sourceFormat,
    inputCount: legacyEntries.length,
    outputCount: kept.length,
    skipped,
  };

  return { artifact, report };
}
