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
 * This module is pure (no DOM/localStorage, no filesystem) so it can run in
 * the browser, under vitest, and inside the Node backfill CLI.
 */

/** Current export artifact schema version. New writes always use this value. */
export const EXPORT_SCHEMA_VERSION = 1;

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

  return {
    artifact,
    report: {
      sourceFormat: options.sourceFormat,
      inputCount: legacyEntries.length,
      outputCount: kept.length,
      skipped,
    },
  };
}

/** Serialize an artifact deterministically (stable key order, 2-space JSON). */
export function serializeArtifact(artifact: ExportArtifactV1): string {
  return JSON.stringify(artifact, null, 2) + "\n";
}

/** True when `value` is a well-formed schema v1 artifact. */
export function isExportArtifact(value: unknown): value is ExportArtifactV1 {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v["schemaVersion"] === EXPORT_SCHEMA_VERSION &&
    typeof v["generation"] === "object" &&
    v["generation"] !== null &&
    Array.isArray(v["entries"]) &&
    v["count"] === (v["entries"] as unknown[]).length
  );
}
