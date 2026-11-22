import { z } from "zod";

export const CREDENTIAL_TYPES = [
  "kyc",
  "age",
  "jurisdiction",
  "income",
  "funds",
  "accreditation",
  "employment",
] as const;

export type CredentialType = (typeof CREDENTIAL_TYPES)[number];

/** One validation failure at the SDK boundary, safe to surface to callers. */
export interface IssuerValidationIssue {
  /** Dotted path to the offending field (`""` for the root payload). */
  path: string;
  message: string;
}

/**
 * Thrown when an input payload passed to `@stellarcred/issuer` fails strict
 * Zod schema validation at the SDK boundary.
 */
export class IssuerValidationError extends Error {
  readonly issues: IssuerValidationIssue[];

  constructor(issues: IssuerValidationIssue[]) {
    super(
      `Invalid issuance payload: ${issues
        .map((issue) => `${issue.path || "input"} — ${issue.message}`)
        .join("; ")}`,
    );
    this.name = "IssuerValidationError";
    this.issues = issues;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

const NON_NEGATIVE_INT_STRING = /^\d+$/;
const ISO_DATE_YYYY_MM_DD = /^\d{4}-\d{2}-\d{2}$/;
const HEX_64 = /^[0-9a-fA-F]{64}$/;
const DURATION_WITH_NUMBER = /\d/;

function nonNegativeIntString(fieldLabel: string) {
  return z
    .string({
      error: `${fieldLabel} must be a non-negative integer string (e.g. "100").`,
    })
    .regex(
      NON_NEGATIVE_INT_STRING,
      `${fieldLabel} must be a non-negative integer string containing only digits 0-9.`,
    );
}

function isValidIsoDateOnOrAfterEpoch(dob: string): boolean {
  if (!ISO_DATE_YYYY_MM_DD.test(dob)) return false;
  const [yearStr, monthStr, dayStr] = dob.split("-");
  const year = Number(yearStr);
  const month = Number(monthStr);
  const day = Number(dayStr);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return false;
  }
  const days = Math.floor(date.getTime() / 86_400_000);
  return Number.isFinite(days) && days >= 0;
}

export const CredentialTypeSchema = z.enum(CREDENTIAL_TYPES, {
  error: (issue) =>
    `Unknown credential type: ${String(issue.input)}. Expected one of: ${CREDENTIAL_TYPES.join(", ")}.`,
});

export const IssuerClientOptionsSchema = z
  .object({
    privateKey: z
      .string({
        error:
          "IssuerClient requires a 64-character hex secp256k1 private key (set ISSUER_PRIVATE_KEY server-side, never NEXT_PUBLIC_).",
      })
      .regex(
        HEX_64,
        "IssuerClient requires a 64-character hex secp256k1 private key (set ISSUER_PRIVATE_KEY server-side, never NEXT_PUBLIC_).",
      ),
  })
  .strict();

export const ClaimParamsSchema = z
  .object({
    threshold_years: nonNegativeIntString("claimParams.threshold_years").optional(),
    threshold: nonNegativeIntString("claimParams.threshold").optional(),
    restricted: z
      .array(nonNegativeIntString("claimParams.restricted entry"), {
        error: "claimParams.restricted must be an array of numeric country-code strings.",
      })
      .optional(),
    mode: z
      .enum(["0", "1"], {
        error: 'claimParams.mode must be "0" (denylist) or "1" (allowlist).',
      })
      .optional(),
  })
  .strict();

export const ExpirySchema = z.union(
  [
    z
      .string()
      .trim()
      .min(1, 'expiry must be a non-empty duration string (e.g. "90 days") or a Unix timestamp.')
      .regex(
        DURATION_WITH_NUMBER,
        'expiry duration string must contain a number (e.g. "90 days").',
      ),
    z
      .number()
      .int("expiry Unix timestamp must be an integer.")
      .nonnegative("expiry Unix timestamp must be a non-negative integer."),
  ],
  {
    error:
      'expiry must be a duration string (e.g. "90 days") or a non-negative integer Unix timestamp.',
  },
);

export const KycAttributeSchema = z.record(
  z.string(),
  z.string({ error: "kyc attribute values must be strings." }),
  { error: "attribute must be an object." },
);

export const AgeAttributeSchema = z
  .object({
    date_of_birth: z
      .string({
        error: 'age credential requires attribute.date_of_birth as a "YYYY-MM-DD" string.',
      })
      .refine(isValidIsoDateOnOrAfterEpoch, {
        message:
          'Invalid date_of_birth: must be a valid calendar date in "YYYY-MM-DD" format on or after 1970-01-01.',
      }),
  })
  .strict();

export const IncomeAttributeSchema = z
  .object({
    income: nonNegativeIntString("attribute.income"),
  })
  .strict();

export const JurisdictionAttributeSchema = z
  .object({
    country_code: nonNegativeIntString("attribute.country_code"),
  })
  .strict();

export const FundsAttributeSchema = z
  .object({
    balance: nonNegativeIntString("attribute.balance"),
  })
  .strict();

export const AccreditationAttributeSchema = z
  .object({
    net_worth: nonNegativeIntString("attribute.net_worth"),
  })
  .strict();

export const EmploymentAttributeSchema = z
  .object({
    seniority: nonNegativeIntString("attribute.seniority").optional(),
  })
  .strict();

const ATTRIBUTE_SCHEMAS: Record<CredentialType, z.ZodType<Record<string, string | undefined>>> = {
  kyc: KycAttributeSchema,
  age: AgeAttributeSchema,
  income: IncomeAttributeSchema,
  jurisdiction: JurisdictionAttributeSchema,
  funds: FundsAttributeSchema,
  accreditation: AccreditationAttributeSchema,
  employment: EmploymentAttributeSchema,
};

export const IssueParamsSchema = z
  .object({
    type: CredentialTypeSchema,
    holder: z
      .string({ error: "holder must be a non-empty string." })
      .trim()
      .min(1, "holder must be a non-empty string."),
    issuerId: z
      .string({ error: "issuerId must be a non-empty string." })
      .trim()
      .min(1, "issuerId must be a non-empty string."),
    issuerName: z
      .string({ error: "issuerName must be a non-empty string." })
      .trim()
      .min(1, "issuerName must be a non-empty string."),
    expiry: ExpirySchema,
    attribute: z.record(z.string(), z.unknown(), {
      error: "attribute must be an object of type-specific credential fields.",
    }),
    claimParams: ClaimParamsSchema.optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    const attrSchema = ATTRIBUTE_SCHEMAS[data.type];
    const result = attrSchema.safeParse(data.attribute);
    if (!result.success) {
      for (const issue of result.error.issues) {
        ctx.addIssue({
          code: "custom",
          path: ["attribute", ...issue.path],
          message: issue.message,
        });
      }
    }
  });

export type ValidatedIssueParams = z.infer<typeof IssueParamsSchema>;

export function formatZodIssues(error: z.ZodError): IssuerValidationIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.map(String).join("."),
    message: issue.message,
  }));
}

export type IssueParamsValidationResult<T> =
  { valid: true; data: T } | { valid: false; errors: IssuerValidationIssue[] };

/**
 * Validates credential issuance parameters without throwing.
 * Returns `{ valid: true, data }` or `{ valid: false, errors }`.
 */
export function validateIssueParams(
  input: unknown,
): IssueParamsValidationResult<ValidatedIssueParams> {
  const result = IssueParamsSchema.safeParse(input);
  if (!result.success) {
    return { valid: false, errors: formatZodIssues(result.error) };
  }
  return { valid: true, data: result.data };
}

/**
 * Validates credential issuance parameters at the SDK boundary, throwing
 * {@link IssuerValidationError} with clear human-readable messages on failure.
 */
export function parseIssueParams(input: unknown): ValidatedIssueParams {
  const result = IssueParamsSchema.safeParse(input);
  if (!result.success) {
    throw new IssuerValidationError(formatZodIssues(result.error));
  }
  return result.data;
}

/**
 * Validates `IssuerClient` constructor options at the SDK boundary.
 */
export function parseIssuerClientOptions(input: unknown): { privateKey: string } {
  const result = IssuerClientOptionsSchema.safeParse(input);
  if (!result.success) {
    throw new IssuerValidationError(formatZodIssues(result.error));
  }
  return result.data;
}
