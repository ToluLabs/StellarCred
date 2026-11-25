export type AttributeDataType =
  "string" | "integer" | "boolean" | "date" | "isoCountryCode" | "currencyAmount";

export type ZkConstraintType =
  "none" | "minThreshold" | "maxThreshold" | "range" | "allowlist" | "denylist" | "equality";

export interface SchemaAttribute {
  id: string;
  name: string;
  type: AttributeDataType;
  required: boolean;
  description: string;
  zkConstraint: ZkConstraintType;
  constraintValue?: string;
  constraintMax?: string;
  constraintList?: string;
}

export interface CredentialSchemaDraft {
  name: string;
  claimSymbol: string;
  version: string;
  description: string;
  defaultExpiryDays: number;
  attributes: SchemaAttribute[];
}

export interface ValidationIssue {
  field: string;
  message: string;
  severity: "error" | "warning";
}

export interface SchemaValidationResult {
  valid: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

export interface StellarCredConstraintDef {
  attribute: string;
  operator: Exclude<ZkConstraintType, "none">;
  threshold?: number;
  min?: number;
  max?: number;
  values?: string[];
  mode?: "0" | "1";
}

export interface JsonLdPropertyDef {
  "@id": string;
  "@type": string;
  required: boolean;
  description?: string;
  stellarCredType: AttributeDataType;
  zkConstraint?: Exclude<ZkConstraintType, "none">;
}

export interface JsonLdCredentialSchema {
  "@context": [
    "https://www.w3.org/2018/credentials/v1",
    "https://schemas.stellarcred.xyz/contexts/v1",
    {
      xsd: "http://www.w3.org/2001/XMLSchema#";
      sc: "https://schemas.stellarcred.xyz/vocab#";
      [key: string]: string | { "@id": string; "@type": string };
    },
  ];
  id: string;
  type: ["VerifiableCredentialSchema", "StellarCredSchema"];
  name: string;
  version: string;
  description: string;
  stellarCred: {
    claimSymbol: string;
    defaultExpiryDays: number;
    constraints: StellarCredConstraintDef[];
  };
  credentialSubject: {
    type: string;
    properties: Record<string, JsonLdPropertyDef>;
    required: string[];
  };
}

export interface SchemaParseResult {
  ok: boolean;
  schema: JsonLdCredentialSchema | null;
  draft: CredentialSchemaDraft | null;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

export interface AttributeCheckResult {
  attribute: string;
  passed: boolean;
  reason: string;
}

export interface PayloadTestResult {
  ok: boolean;
  parseError?: string;
  checks: AttributeCheckResult[];
}

const XSD_TYPE_MAP: Record<AttributeDataType, string> = {
  string: "xsd:string",
  integer: "xsd:integer",
  boolean: "xsd:boolean",
  date: "xsd:date",
  isoCountryCode: "xsd:integer",
  currencyAmount: "xsd:integer",
};

const NUMERIC_TYPES: ReadonlySet<AttributeDataType> = new Set([
  "integer",
  "isoCountryCode",
  "currencyAmount",
]);

const ATTRIBUTE_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_]*$/;
const CLAIM_SYMBOL_RE = /^[a-zA-Z0-9_]{1,9}$/;
const SEMVER_RE = /^\d+\.\d+\.\d+$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function toSchemaSlug(name: string): string {
  return (
    name
      .trim()
      .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
      .replace(/[^a-zA-Z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .toLowerCase() || "custom-credential"
  );
}

function parseListItems(raw?: string): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function validateSchemaDraft(draft: CredentialSchemaDraft): SchemaValidationResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  if (!draft.name.trim()) {
    errors.push({
      field: "name",
      message: "Schema name is required.",
      severity: "error",
    });
  } else if (!/^[A-Z][a-zA-Z0-9]*$/.test(draft.name.trim())) {
    warnings.push({
      field: "name",
      message: "Schema name should use PascalCase (e.g. AccreditedInvestorCredential).",
      severity: "warning",
    });
  }

  if (!draft.claimSymbol.trim()) {
    errors.push({
      field: "claimSymbol",
      message: "Claim symbol is required for Soroban ProofRegistry indexing.",
      severity: "error",
    });
  } else if (!CLAIM_SYMBOL_RE.test(draft.claimSymbol.trim())) {
    errors.push({
      field: "claimSymbol",
      message:
        "Claim symbol must be 1–9 ASCII alphanumeric/underscore characters (Soroban symbol_short! limit).",
      severity: "error",
    });
  }

  if (!SEMVER_RE.test(draft.version.trim())) {
    errors.push({
      field: "version",
      message: "Version must follow semantic versioning (e.g. 1.0.0).",
      severity: "error",
    });
  }

  if (!Number.isInteger(draft.defaultExpiryDays) || draft.defaultExpiryDays <= 0) {
    errors.push({
      field: "defaultExpiryDays",
      message: "Default expiry must be a positive whole number of days.",
      severity: "error",
    });
  } else if (draft.defaultExpiryDays > 3650) {
    warnings.push({
      field: "defaultExpiryDays",
      message: "Expiry exceeds 10 years; shorter validity windows are recommended.",
      severity: "warning",
    });
  }

  if (draft.attributes.length === 0) {
    errors.push({
      field: "attributes",
      message: "Define at least one credential subject attribute.",
      severity: "error",
    });
  }

  const seenNames = new Set<string>();
  draft.attributes.forEach((attr, index) => {
    const prefix = `attributes[${index}]`;
    const trimmed = attr.name.trim();

    if (!trimmed) {
      errors.push({
        field: `${prefix}.name`,
        message: `Attribute #${index + 1} is missing a name.`,
        severity: "error",
      });
    } else if (!ATTRIBUTE_NAME_RE.test(trimmed)) {
      errors.push({
        field: `${prefix}.name`,
        message: `Attribute "${trimmed}" must start with a letter and contain only letters, digits, or underscores.`,
        severity: "error",
      });
    } else if (seenNames.has(trimmed)) {
      errors.push({
        field: `${prefix}.name`,
        message: `Duplicate attribute name "${trimmed}".`,
        severity: "error",
      });
    } else {
      seenNames.add(trimmed);
    }

    const { zkConstraint, type } = attr;
    if (
      (zkConstraint === "minThreshold" ||
        zkConstraint === "maxThreshold" ||
        zkConstraint === "range") &&
      !NUMERIC_TYPES.has(type) &&
      type !== "date"
    ) {
      errors.push({
        field: `${prefix}.zkConstraint`,
        message: `Constraint "${zkConstraint}" on "${trimmed || `#${index + 1}`}" requires a numeric or date attribute type.`,
        severity: "error",
      });
    }

    if (zkConstraint === "minThreshold" || zkConstraint === "maxThreshold") {
      const val = Number(attr.constraintValue);
      if (
        attr.constraintValue === undefined ||
        attr.constraintValue.trim() === "" ||
        Number.isNaN(val)
      ) {
        errors.push({
          field: `${prefix}.constraintValue`,
          message: `Attribute "${trimmed || `#${index + 1}`}" requires a numeric threshold value.`,
          severity: "error",
        });
      }
    }

    if (zkConstraint === "range") {
      const min = Number(attr.constraintValue);
      const max = Number(attr.constraintMax);
      if (
        !attr.constraintValue?.trim() ||
        !attr.constraintMax?.trim() ||
        Number.isNaN(min) ||
        Number.isNaN(max)
      ) {
        errors.push({
          field: `${prefix}.constraintValue`,
          message: `Range constraint on "${trimmed || `#${index + 1}`}" requires numeric min and max values.`,
          severity: "error",
        });
      } else if (min > max) {
        errors.push({
          field: `${prefix}.constraintMax`,
          message: `Range min (${min}) cannot be greater than max (${max}) on "${trimmed || `#${index + 1}`}".`,
          severity: "error",
        });
      }
    }

    if (zkConstraint === "allowlist" || zkConstraint === "denylist") {
      const items = parseListItems(attr.constraintList);
      if (items.length === 0) {
        errors.push({
          field: `${prefix}.constraintList`,
          message: `Constraint "${zkConstraint}" on "${trimmed || `#${index + 1}`}" requires at least one comma-separated value.`,
          severity: "error",
        });
      }
    }

    if (zkConstraint === "equality" && !attr.constraintValue?.trim()) {
      errors.push({
        field: `${prefix}.constraintValue`,
        message: `Equality constraint on "${trimmed || `#${index + 1}`}" requires an expected value.`,
        severity: "error",
      });
    }
  });

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

export function buildJsonLdSchema(draft: CredentialSchemaDraft): JsonLdCredentialSchema {
  const slug = toSchemaSlug(draft.name);
  const schemaId = `https://schemas.stellarcred.xyz/v1/${slug}.jsonld`;
  const contextTerms: {
    xsd: "http://www.w3.org/2001/XMLSchema#";
    sc: "https://schemas.stellarcred.xyz/vocab#";
    [key: string]: string | { "@id": string; "@type": string };
  } = {
    xsd: "http://www.w3.org/2001/XMLSchema#",
    sc: "https://schemas.stellarcred.xyz/vocab#",
  };

  const properties: Record<string, JsonLdPropertyDef> = {};
  const required: string[] = [];
  const constraints: StellarCredConstraintDef[] = [];

  for (const attr of draft.attributes) {
    const name = attr.name.trim();
    if (!name) continue;

    const xsdType = XSD_TYPE_MAP[attr.type];
    contextTerms[name] = {
      "@id": `sc:${name}`,
      "@type": xsdType,
    };

    const propDef: JsonLdPropertyDef = {
      "@id": `sc:${name}`,
      "@type": xsdType,
      required: attr.required,
      stellarCredType: attr.type,
    };

    if (attr.description.trim()) {
      propDef.description = attr.description.trim();
    }

    if (attr.zkConstraint !== "none") {
      propDef.zkConstraint = attr.zkConstraint;
      const constraint: StellarCredConstraintDef = {
        attribute: name,
        operator: attr.zkConstraint,
      };

      if (attr.zkConstraint === "minThreshold" || attr.zkConstraint === "maxThreshold") {
        const num = Number(attr.constraintValue);
        if (!Number.isNaN(num)) {
          constraint.threshold = num;
        }
      } else if (attr.zkConstraint === "range") {
        const min = Number(attr.constraintValue);
        const max = Number(attr.constraintMax);
        if (!Number.isNaN(min)) constraint.min = min;
        if (!Number.isNaN(max)) constraint.max = max;
      } else if (attr.zkConstraint === "allowlist" || attr.zkConstraint === "denylist") {
        constraint.values = parseListItems(attr.constraintList);
        constraint.mode = attr.zkConstraint === "allowlist" ? "1" : "0";
      } else if (attr.zkConstraint === "equality") {
        constraint.values = attr.constraintValue?.trim() ? [attr.constraintValue.trim()] : [];
      }

      constraints.push(constraint);
    }

    properties[name] = propDef;
    if (attr.required) {
      required.push(name);
    }
  }

  return {
    "@context": [
      "https://www.w3.org/2018/credentials/v1",
      "https://schemas.stellarcred.xyz/contexts/v1",
      contextTerms,
    ],
    id: schemaId,
    type: ["VerifiableCredentialSchema", "StellarCredSchema"],
    name: draft.name.trim() || "CustomCredential",
    version: draft.version.trim() || "1.0.0",
    description: draft.description.trim(),
    stellarCred: {
      claimSymbol: draft.claimSymbol.trim(),
      defaultExpiryDays: draft.defaultExpiryDays,
      constraints,
    },
    credentialSubject: {
      type: `${draft.name.trim() || "CustomCredential"}Subject`,
      properties,
      required,
    },
  };
}

export function parseJsonLdSchema(rawJson: string): SchemaParseResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  if (!rawJson.trim()) {
    return {
      ok: false,
      schema: null,
      draft: null,
      errors: [
        {
          field: "json",
          message: "JSON-LD input is empty.",
          severity: "error",
        },
      ],
      warnings,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch (err: unknown) {
    return {
      ok: false,
      schema: null,
      draft: null,
      errors: [
        {
          field: "json",
          message:
            err instanceof Error ? `Invalid JSON syntax: ${err.message}` : "Invalid JSON syntax.",
          severity: "error",
        },
      ],
      warnings,
    };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      ok: false,
      schema: null,
      draft: null,
      errors: [
        {
          field: "root",
          message: "JSON-LD schema must be a JSON object.",
          severity: "error",
        },
      ],
      warnings,
    };
  }

  const obj = parsed as Record<string, unknown>;

  if (!Array.isArray(obj["@context"])) {
    errors.push({
      field: "@context",
      message:
        'Missing or invalid "@context" array. Expected W3C Credentials v1 and StellarCred context.',
      severity: "error",
    });
  } else {
    const ctx = obj["@context"] as unknown[];
    if (!ctx.includes("https://www.w3.org/2018/credentials/v1")) {
      warnings.push({
        field: "@context",
        message: 'Recommended W3C context "https://www.w3.org/2018/credentials/v1" is not present.',
        severity: "warning",
      });
    }
  }

  if (typeof obj.id !== "string" || !obj.id.trim()) {
    errors.push({
      field: "id",
      message: 'Missing required string field "id".',
      severity: "error",
    });
  }

  if (!Array.isArray(obj.type) || !obj.type.includes("VerifiableCredentialSchema")) {
    errors.push({
      field: "type",
      message: 'Field "type" must include "VerifiableCredentialSchema".',
      severity: "error",
    });
  }

  const name = typeof obj.name === "string" ? obj.name : "";
  const version = typeof obj.version === "string" ? obj.version : "1.0.0";
  const description = typeof obj.description === "string" ? obj.description : "";

  const sc =
    obj.stellarCred && typeof obj.stellarCred === "object"
      ? (obj.stellarCred as Record<string, unknown>)
      : null;

  if (!sc) {
    errors.push({
      field: "stellarCred",
      message: 'Missing required "stellarCred" metadata block.',
      severity: "error",
    });
  }

  const claimSymbol = sc && typeof sc.claimSymbol === "string" ? sc.claimSymbol : "";
  const defaultExpiryDays =
    sc && typeof sc.defaultExpiryDays === "number" ? sc.defaultExpiryDays : 365;
  const rawConstraints =
    sc && Array.isArray(sc.constraints) ? (sc.constraints as StellarCredConstraintDef[]) : [];

  const subject =
    obj.credentialSubject && typeof obj.credentialSubject === "object"
      ? (obj.credentialSubject as Record<string, unknown>)
      : null;

  if (!subject || !subject.properties || typeof subject.properties !== "object") {
    errors.push({
      field: "credentialSubject.properties",
      message: 'Missing required "credentialSubject.properties" object.',
      severity: "error",
    });
  }

  const attributes: SchemaAttribute[] = [];
  if (subject && subject.properties && typeof subject.properties === "object") {
    const props = subject.properties as Record<string, Record<string, unknown>>;
    const constraintByAttr = new Map<string, StellarCredConstraintDef>();
    for (const c of rawConstraints) {
      if (c && typeof c.attribute === "string") {
        constraintByAttr.set(c.attribute, c);
      }
    }

    Object.entries(props).forEach(([attrName, propDef], idx) => {
      const constraint = constraintByAttr.get(attrName);
      const validTypes: AttributeDataType[] = [
        "string",
        "integer",
        "boolean",
        "date",
        "isoCountryCode",
        "currencyAmount",
      ];
      const rawType = propDef?.stellarCredType as AttributeDataType;
      const inferredType: AttributeDataType = validTypes.includes(rawType)
        ? rawType
        : propDef?.["@type"] === "xsd:integer"
          ? "integer"
          : propDef?.["@type"] === "xsd:boolean"
            ? "boolean"
            : propDef?.["@type"] === "xsd:date"
              ? "date"
              : "string";

      const zkConstraint: ZkConstraintType =
        constraint?.operator ?? (propDef?.zkConstraint as ZkConstraintType | undefined) ?? "none";

      let constraintValue: string | undefined;
      let constraintMax: string | undefined;
      let constraintList: string | undefined;

      if (constraint) {
        if (constraint.threshold !== undefined) {
          constraintValue = String(constraint.threshold);
        } else if (constraint.min !== undefined) {
          constraintValue = String(constraint.min);
          if (constraint.max !== undefined) {
            constraintMax = String(constraint.max);
          }
        } else if (constraint.operator === "allowlist" || constraint.operator === "denylist") {
          constraintList = (constraint.values ?? []).join(", ");
        } else if (constraint.operator === "equality") {
          constraintValue = constraint.values?.[0] ?? "";
        }
      }

      attributes.push({
        id: `parsed-${idx}-${attrName}`,
        name: attrName,
        type: inferredType,
        required: Boolean(propDef?.required),
        description: typeof propDef?.description === "string" ? propDef.description : "",
        zkConstraint,
        constraintValue,
        constraintMax,
        constraintList,
      });
    });
  }

  const draft: CredentialSchemaDraft = {
    name,
    claimSymbol,
    version,
    description,
    defaultExpiryDays,
    attributes,
  };

  const draftValidation = validateSchemaDraft(draft);
  errors.push(...draftValidation.errors);
  warnings.push(...draftValidation.warnings);

  return {
    ok: errors.length === 0,
    schema: errors.length === 0 ? (parsed as JsonLdCredentialSchema) : null,
    draft,
    errors,
    warnings,
  };
}

export function validateSamplePayload(
  draft: CredentialSchemaDraft,
  rawPayload: string,
): PayloadTestResult {
  let payload: unknown;
  try {
    payload = JSON.parse(rawPayload);
  } catch (err: unknown) {
    return {
      ok: false,
      parseError: err instanceof Error ? `Invalid JSON: ${err.message}` : "Invalid JSON payload.",
      checks: [],
    };
  }

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return {
      ok: false,
      parseError: "Sample payload must be a JSON object.",
      checks: [],
    };
  }

  const record = payload as Record<string, unknown>;
  const checks: AttributeCheckResult[] = [];

  for (const attr of draft.attributes) {
    const name = attr.name.trim();
    if (!name) continue;
    const val = record[name];

    if (val === undefined || val === null || val === "") {
      if (attr.required) {
        checks.push({
          attribute: name,
          passed: false,
          reason: "Missing required attribute.",
        });
      } else {
        checks.push({
          attribute: name,
          passed: true,
          reason: "Optional attribute omitted.",
        });
      }
      continue;
    }

    // Type validation
    let typeOk = true;
    let typeReason = "";
    if (attr.type === "boolean") {
      typeOk = typeof val === "boolean";
      typeReason = "Expected boolean (true/false).";
    } else if (attr.type === "string") {
      typeOk = typeof val === "string";
      typeReason = "Expected string.";
    } else if (attr.type === "date") {
      typeOk = typeof val === "string" && ISO_DATE_RE.test(val);
      typeReason = "Expected ISO date (YYYY-MM-DD).";
    } else if (NUMERIC_TYPES.has(attr.type)) {
      typeOk = typeof val === "number" && Number.isInteger(val);
      typeReason = `Expected integer for ${attr.type}.`;
    }

    if (!typeOk) {
      checks.push({ attribute: name, passed: false, reason: typeReason });
      continue;
    }

    // ZK constraint evaluation
    if (attr.zkConstraint === "minThreshold") {
      const threshold = Number(attr.constraintValue);
      const passed = typeof val === "number" && val >= threshold;
      checks.push({
        attribute: name,
        passed,
        reason: passed
          ? `Passed: ${val} >= ${threshold}`
          : `Failed: ${val} is below minimum threshold ${threshold}`,
      });
    } else if (attr.zkConstraint === "maxThreshold") {
      const threshold = Number(attr.constraintValue);
      const passed = typeof val === "number" && val <= threshold;
      checks.push({
        attribute: name,
        passed,
        reason: passed
          ? `Passed: ${val} <= ${threshold}`
          : `Failed: ${val} exceeds maximum threshold ${threshold}`,
      });
    } else if (attr.zkConstraint === "range") {
      const min = Number(attr.constraintValue);
      const max = Number(attr.constraintMax);
      const passed = typeof val === "number" && val >= min && val <= max;
      checks.push({
        attribute: name,
        passed,
        reason: passed
          ? `Passed: ${val} is within [${min}, ${max}]`
          : `Failed: ${val} is outside [${min}, ${max}]`,
      });
    } else if (attr.zkConstraint === "allowlist") {
      const allowed = parseListItems(attr.constraintList);
      const passed = allowed.includes(String(val));
      checks.push({
        attribute: name,
        passed,
        reason: passed
          ? `Passed: "${val}" is in allowlist`
          : `Failed: "${val}" is not in allowlist [${allowed.join(", ")}]`,
      });
    } else if (attr.zkConstraint === "denylist") {
      const denied = parseListItems(attr.constraintList);
      const passed = !denied.includes(String(val));
      checks.push({
        attribute: name,
        passed,
        reason: passed
          ? `Passed: "${val}" is not restricted`
          : `Failed: "${val}" is in restricted denylist`,
      });
    } else if (attr.zkConstraint === "equality") {
      const expected = attr.constraintValue?.trim() ?? "";
      const passed = String(val) === expected;
      checks.push({
        attribute: name,
        passed,
        reason: passed
          ? `Passed: equals "${expected}"`
          : `Failed: expected "${expected}", got "${val}"`,
      });
    } else {
      checks.push({
        attribute: name,
        passed: true,
        reason: `Valid ${attr.type}`,
      });
    }
  }

  return {
    ok: checks.every((c) => c.passed),
    checks,
  };
}

export function buildSamplePayload(draft: CredentialSchemaDraft): Record<string, unknown> {
  const sample: Record<string, unknown> = {};
  for (const attr of draft.attributes) {
    const name = attr.name.trim();
    if (!name) continue;

    if (attr.type === "boolean") {
      sample[name] = true;
    } else if (attr.type === "date") {
      sample[name] = "1998-05-15";
    } else if (attr.type === "isoCountryCode") {
      const items = parseListItems(attr.constraintList);
      if (attr.zkConstraint === "allowlist" && items.length > 0) {
        sample[name] = Number(items[0]) || 276;
      } else {
        sample[name] = 276;
      }
    } else if (NUMERIC_TYPES.has(attr.type)) {
      if (attr.zkConstraint === "minThreshold" || attr.zkConstraint === "range") {
        const base = Number(attr.constraintValue);
        sample[name] = Number.isNaN(base) ? 100 : base;
      } else if (attr.zkConstraint === "maxThreshold") {
        const base = Number(attr.constraintValue);
        sample[name] = Number.isNaN(base) ? 10 : base;
      } else {
        sample[name] = 100;
      }
    } else {
      if (attr.zkConstraint === "equality" && attr.constraintValue?.trim()) {
        sample[name] = attr.constraintValue.trim();
      } else if (attr.zkConstraint === "allowlist") {
        const items = parseListItems(attr.constraintList);
        sample[name] = items[0] ?? "verified";
      } else {
        sample[name] = "verified";
      }
    }
  }
  return sample;
}

export interface SchemaPreset {
  id: string;
  label: string;
  draft: CredentialSchemaDraft;
}

export const SCHEMA_PRESETS: SchemaPreset[] = [
  {
    id: "funds",
    label: "Proof of Funds",
    draft: {
      name: "ProofOfFundsCredential",
      claimSymbol: "funds",
      version: "1.0.0",
      description:
        "Zero-knowledge attestation that a holder controls liquid funds above a protocol threshold.",
      defaultExpiryDays: 30,
      attributes: [
        {
          id: "funds-balance",
          name: "balanceUsd",
          type: "currencyAmount",
          required: true,
          description: "Verified liquid balance in USD.",
          zkConstraint: "minThreshold",
          constraintValue: "50000",
        },
        {
          id: "funds-verified",
          name: "accountVerified",
          type: "boolean",
          required: true,
          description: "Bank account ownership verified via Plaid attestation.",
          zkConstraint: "equality",
          constraintValue: "true",
        },
      ],
    },
  },
  {
    id: "age",
    label: "Age Gate (18+)",
    draft: {
      name: "AgeVerificationCredential",
      claimSymbol: "age",
      version: "1.0.0",
      description:
        "Proves holder meets minimum legal age threshold without disclosing date of birth.",
      defaultExpiryDays: 365,
      attributes: [
        {
          id: "age-years",
          name: "ageYears",
          type: "integer",
          required: true,
          description: "Computed age in full years.",
          zkConstraint: "minThreshold",
          constraintValue: "18",
        },
      ],
    },
  },
  {
    id: "jurisdiction",
    label: "Jurisdiction Compliance",
    draft: {
      name: "JurisdictionCredential",
      claimSymbol: "jurisdict",
      version: "1.0.0",
      description: "Proves holder resides outside sanctioned ISO-3166 numeric country codes.",
      defaultExpiryDays: 180,
      attributes: [
        {
          id: "jurisdiction-country",
          name: "countryCode",
          type: "isoCountryCode",
          required: true,
          description: "ISO 3166-1 numeric country code.",
          zkConstraint: "denylist",
          constraintList: "408, 364, 760",
        },
      ],
    },
  },
  {
    id: "kyc",
    label: "KYC Identity",
    draft: {
      name: "KycIdentityCredential",
      claimSymbol: "kyc",
      version: "1.0.0",
      description: "Binary identity verification credential issued by a registered KYC provider.",
      defaultExpiryDays: 365,
      attributes: [
        {
          id: "kyc-level",
          name: "verificationLevel",
          type: "string",
          required: true,
          description: "KYC assurance tier.",
          zkConstraint: "allowlist",
          constraintList: "tier2, tier3",
        },
      ],
    },
  },
];
