import { describe, it, expect } from "vitest";
import {
  EXPORT_SCHEMA_VERSION,
  LegacyExportError,
  isExportArtifact,
  parseLegacyCsv,
  parseLegacyJson,
  planBackfill,
  serializeArtifact,
  validateEntry,
  type ExportEntry,
} from "../export-schema";

// A fixed clock keeps the generation metadata deterministic.
const FIXED_NOW = () => new Date("2026-01-02T03:04:05.000Z");

const entry = (overrides: Partial<ExportEntry> = {}): ExportEntry => ({
  claimType: "kyc",
  verifiedAt: 1_700_000_000,
  expiry: 1_702_592_000,
  txHash: "abc123",
  issuer: "GISSUER",
  ...overrides,
});

describe("parseLegacyJson", () => {
  it("reads the unversioned { exportedAt, entries } shape", () => {
    const text = JSON.stringify({
      exportedAt: "2025-12-01T00:00:00.000Z",
      entries: [entry(), entry({ claimType: "age", txHash: "", issuer: "" })],
    });
    const parsed = parseLegacyJson(text);
    expect(parsed.exportedAt).toBe("2025-12-01T00:00:00.000Z");
    expect(parsed.entries).toHaveLength(2);
    expect(parsed.entries[1].claimType).toBe("age");
  });

  it("throws on non-object or missing fields", () => {
    expect(() => parseLegacyJson("[]")).toThrow(LegacyExportError);
    expect(() => parseLegacyJson('{"entries":[]}')).toThrow(/exportedAt/);
    expect(() => parseLegacyJson('{"exportedAt":"x"}')).toThrow(/entries/);
    expect(() => parseLegacyJson("{not json")).toThrow(LegacyExportError);
  });

  it("rejects a non-numeric timestamp instead of coercing", () => {
    const text = JSON.stringify({
      exportedAt: "2025-12-01T00:00:00.000Z",
      entries: [{ ...entry(), verifiedAt: "soon" }],
    });
    expect(() => parseLegacyJson(text)).toThrow(/verifiedAt/);
  });
});

describe("parseLegacyCsv", () => {
  it("parses headers, ISO timestamps, and empty expiry as 0", () => {
    const csv =
      "claim_type,verified_at,expiry,tx_hash,issuer\n" +
      'kyc,"2023-11-14T22:13:20.000Z","2023-12-14T22:13:20.000Z",abc123,GISSUER\n';
    const parsed = parseLegacyCsv(csv);
    expect(parsed.entries[0].verifiedAt).toBe(1_700_000_000);
    expect(parsed.entries[0].expiry).toBe(1_702_592_000);
    expect(parsed.entries[0].txHash).toBe("abc123");
  });

  it("honours quoted commas and escaped double-quotes", () => {
    const csv =
      'claim_type,verified_at,expiry,tx_hash,issuer\n' +
      'kyc,1700000000,0,"tx,with-comma","issuer ""G"""\n';
    const parsed = parseLegacyCsv(csv);
    expect(parsed.entries[0].txHash).toBe("tx,with-comma");
    expect(parsed.entries[0].issuer).toBe('issuer "G"');
  });

  it("reads a headerless file positionally", () => {
    const parsed = parseLegacyCsv("kyc,1700000000,0,tx,G\n");
    expect(parsed.entries[0]).toEqual(
      entry({ verifiedAt: 1_700_000_000, expiry: 0, txHash: "tx", issuer: "G" })
    );
  });

  it("treats a numeric expiry of 0 as unknown, not a parsed date", () => {
    // Regression: Date.parse("0") is a valid year in V8's lenient parser.
    expect(parseLegacyCsv("kyc,1700000000,0,tx,G\n").entries[0].expiry).toBe(0);
  });

  it("survives a trailing newline and blank lines", () => {
    const csv = "claim_type,verified_at,expiry,tx_hash,issuer\n\nkyc,1700000000,0,tx,G\n\n";
    expect(parseLegacyCsv(csv).entries).toHaveLength(1);
  });
});

describe("validateEntry", () => {
  it("accepts expiry === 0 as 'unknown'", () => {
    expect(validateEntry(entry({ expiry: 0 }))).toBeNull();
  });
  it("rejects empty claimType, negative and non-integer timestamps", () => {
    expect(validateEntry(entry({ claimType: "  " }))).toMatch(/claimType/);
    expect(validateEntry(entry({ verifiedAt: -1 }))).toMatch(/verifiedAt/);
    expect(validateEntry(entry({ verifiedAt: 1.5 }))).toMatch(/verifiedAt/);
    expect(validateEntry(entry({ expiry: -2 }))).toMatch(/expiry/);
  });
  it("rejects an expiry before its verification", () => {
    expect(validateEntry(entry({ verifiedAt: 100, expiry: 50 }))).toMatch(/before/);
  });
});

describe("planBackfill", () => {
  it("produces a schema v1 artifact with generation metadata", () => {
    const { artifact, report } = planBackfill([entry()], {
      generator: "backfill-export",
      sourceFormat: "legacy-json",
      sourceExportedAt: "2025-12-01T00:00:00.000Z",
      now: FIXED_NOW,
    });
    expect(artifact.schemaVersion).toBe(EXPORT_SCHEMA_VERSION);
    expect(artifact.count).toBe(1);
    expect(artifact.entries).toEqual([entry()]);
    expect(artifact.generation).toEqual({
      generatedAt: "2026-01-02T03:04:05.000Z",
      generator: "backfill-export",
      sourceFormat: "legacy-json",
      sourceExportedAt: "2025-12-01T00:00:00.000Z",
    });
    expect(report).toEqual({
      sourceFormat: "legacy-json",
      inputCount: 1,
      outputCount: 1,
      skipped: [],
    });
    expect(isExportArtifact(artifact)).toBe(true);
  });

  it("skips invalid entries and reports their 1-based index", () => {
    const { artifact, report } = planBackfill(
      [entry(), entry({ verifiedAt: -1 }), entry({ claimType: "" })],
      { generator: "g", sourceFormat: "legacy-csv", now: FIXED_NOW }
    );
    expect(report.inputCount).toBe(3);
    expect(report.outputCount).toBe(1);
    expect(artifact.count).toBe(1);
    expect(report.skipped).toEqual([
      { index: 2, reason: "verifiedAt must be a non-negative integer" },
      { index: 3, reason: "claimType is empty" },
    ]);
  });

  it("omits sourceExportedAt when the source has none", () => {
    const { artifact } = planBackfill([entry()], {
      generator: "g",
      sourceFormat: "legacy-csv",
      now: FIXED_NOW,
    });
    expect("sourceExportedAt" in artifact.generation).toBe(false);
  });
});

describe("serializeArtifact", () => {
  it("emits stable JSON that re-parses into a valid artifact", () => {
    const { artifact } = planBackfill([entry()], {
      generator: "g",
      sourceFormat: "legacy-json",
      now: FIXED_NOW,
    });
    const text = serializeArtifact(artifact);
    expect(text.endsWith("\n")).toBe(true);
    expect(isExportArtifact(JSON.parse(text))).toBe(true);
  });
});
