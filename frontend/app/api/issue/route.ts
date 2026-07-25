import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
// Resolved by webpack at build time — avoids process.cwd() which is unreliable
// in Next.js server routes (can return "/" depending on how the server starts).
import commitCircuit from "../../../public/circuits/commit.json";
import { logger, stripSensitiveFields } from "../../../lib/logger";

// Server-side only — never shipped to the browser.
// Set ISSUER_PRIVATE_KEY in .env.local to the 64-char hex secp256k1 private
// key whose public key was registered in IssuerRegistry. The registered pubkey
// and the signing key must match or ProofRegistry will reject every proof.
const DEMO_SK = process.env.ISSUER_PRIVATE_KEY
  ? Buffer.from(process.env.ISSUER_PRIVATE_KEY, "hex")
  : sha256(new TextEncoder().encode("stellarcred-demo-issuer"));

function be32(v: bigint): Uint8Array {
  const b = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) {
    b[i] = Number(v & 255n);
    v >>= 8n;
  }
  return b;
}

function randomField(): string {
  // 31 bytes = 248 bits, always fits in BN254 scalar field.
  return "0x" + randomBytes(31).toString("hex");
}

// Derive the circuit `value` (preimage) for a credential type from the shared
// verification attributes. One Persona/KYC response carries everything needed
// for every requested type, so each type just reads the field it cares about.
function attributeToValue(type: string, attributes: Record<string, string>): string {
  switch (type) {
    case "kyc":
      // Binary claim — no attribute to commit, just a fresh random secret.
      return randomField();
    case "age": {
      const dob = attributes.date_of_birth;
      if (!dob) throw new Error("age credential requires attributes.date_of_birth");
      const days = Math.floor(new Date(dob).getTime() / 86_400_000);
      if (!Number.isFinite(days)) throw new Error("Invalid date_of_birth");
      return String(days);
    }
    case "income": {
      const income = parseInt(attributes.income ?? "", 10);
      if (!Number.isFinite(income)) throw new Error("income credential requires attributes.income");
      return String(income);
    }
    case "jurisdiction": {
      const country = parseInt(attributes.country_code ?? "", 10);
      if (!Number.isFinite(country)) throw new Error("jurisdiction credential requires attributes.country_code");
      return String(country);
    }
    case "funds": {
      const balance = parseInt(attributes.balance ?? "", 10);
      if (!Number.isFinite(balance)) throw new Error("funds credential requires attributes.balance");
      return String(balance);
    }
    case "accreditation": {
      const netWorth = parseInt(attributes.net_worth ?? "", 10);
      if (!Number.isFinite(netWorth)) throw new Error("accreditation credential requires attributes.net_worth");
      return String(netWorth);
    }
    default:
      throw new Error(`Unknown credential type: ${type}`);
  }
}

async function poseidonCommit(value: string, salt: string): Promise<string> {
  const { Noir } = await import("@noir-lang/noir_js");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const noir = new Noir(commitCircuit as any);
  const { returnValue } = await noir.execute({ value, salt });
  return String(returnValue);
}

function issuerPublicKey(): { x: number[]; y: number[] } {
  const p = secp256k1.getPublicKey(DEMO_SK, false); // 0x04 || x || y
  return { x: Array.from(p.slice(1, 33)), y: Array.from(p.slice(33, 65)) };
}

function signCommitment(commitment: string): {
  sig: number[];
  issuerX: number[];
  issuerY: number[];
} {
  const sig = secp256k1.sign(be32(BigInt(commitment)), DEMO_SK, { prehash: false });
  const { x, y } = issuerPublicKey();
  return { sig: Array.from(sig), issuerX: x, issuerY: y };
}

// ---------------------------------------------------------------------------
// Persona identity verification relay
// ---------------------------------------------------------------------------
// Two templates are supported:
//   PERSONA_KYC_TEMPLATE_ID  — government ID flow; issues kyc + age + jurisdiction
//   PERSONA_AGE_TEMPLATE_ID  — selfie age estimation; issues age credential only
//
// If PERSONA_API_KEY is not set → demo fallback (always passes).
// If PERSONA_API_KEY is set but the relevant template ID is missing → loud error.
// ---------------------------------------------------------------------------

const PERSONA_BASE = "https://withpersona.com/api/v1";
const PERSONA_VERSION = "2023-01-05";

function personaHeaders() {
  return {
    Authorization: `Bearer ${process.env.PERSONA_API_KEY}`,
    "Content-Type": "application/json",
    "Persona-Version": PERSONA_VERSION,
  };
}

async function createPersonaInquiry(
  templateId: string,
  redirectUri: string,
): Promise<{ url: string; id: string }> {
  const res = await fetch(`${PERSONA_BASE}/inquiries`, {
    method: "POST",
    headers: personaHeaders(),
    body: JSON.stringify({
      data: {
        attributes: {
          "inquiry-template-id": templateId,
          "redirect-uri": redirectUri,
        },
      },
    }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`Persona: failed to create inquiry — ${JSON.stringify(json)}`);
  const id: string = json.data.id;
  // Persona hosted flow URL
  const url = `https://withpersona.com/verify?inquiry-id=${id}`;
  return { url, id };
}

async function retrievePersonaInquiry(inquiryId: string): Promise<{
  status: string;
  fields: Record<string, { value: unknown }>;
}> {
  const res = await fetch(`${PERSONA_BASE}/inquiries/${inquiryId}`, {
    headers: personaHeaders(),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`Persona: failed to retrieve inquiry — ${JSON.stringify(json)}`);
  return {
    status: json.data.attributes.status as string,
    fields: (json.data.attributes.fields ?? {}) as Record<string, { value: unknown }>,
  };
}

// Minimal ISO 3166-1 alpha-2 → numeric map for countries we care about.
// Persona returns alpha-2 codes; our jurisdiction circuit uses numeric.
const ALPHA2_TO_NUMERIC: Record<string, string> = {
  NG: "566", US: "840", DE: "276", IN: "356", IR: "364",
  GB: "826", FR: "250", CA: "124", AU: "036", BR: "076",
  CN: "156", JP: "392", KR: "410", ZA: "710", GH: "288",
  KE: "404", EG: "818", MX: "484", AR: "032", SG: "702",
};

function alpha2ToNumeric(code: string): string {
  return ALPHA2_TO_NUMERIC[code.toUpperCase()] ?? "0";
}

// Called after user returns from Persona KYC (gov ID) inquiry.
// Returns DOB and country so we can issue age + jurisdiction credentials.
async function resolvePersonaKYC(inquiryId: string): Promise<{
  ok: boolean;
  dob?: string;
  countryNumeric?: string;
  error?: string;
}> {
  const { status, fields } = await retrievePersonaInquiry(inquiryId);
  if (status !== "approved") {
    return { ok: false, error: `Persona KYC inquiry status: ${status}` };
  }
  const dob =
    String(fields["birthdate"]?.value ?? fields["birth-date"]?.value ?? "").trim() || undefined;
  const alpha2 =
    String(
      fields["selected-country-code"]?.value ??
      fields["country-code"]?.value ??
      fields["address-country-code"]?.value ??
      "",
    ).trim() || undefined;
  return {
    ok: true,
    dob,
    countryNumeric: alpha2 ? alpha2ToNumeric(alpha2) : undefined,
  };
}


// Plaid balance attestation relay. Returns the verified balance from the user's
// bank — this becomes the credential value, not what the user typed.
// Mock mode: no PLAID_ACCESS_TOKEN set → returns a mock balance of $50,000.
async function verifyWithPlaid(): Promise<{ ok: boolean; balance?: number; error?: string }> {
  if (!process.env.PLAID_ACCESS_TOKEN) {
    console.warn(
      "[StellarCred] PLAID_ACCESS_TOKEN not set — running in mock mode, returning mock balance $50,000",
    );
    return { ok: true, balance: 50000 };
  }

  const env = process.env.PLAID_ENV ?? "sandbox";
  const baseUrl =
    env === "production"
      ? "https://production.plaid.com"
      : env === "development"
        ? "https://development.plaid.com"
        : "https://sandbox.plaid.com";

  const response = await fetch(`${baseUrl}/accounts/balance/get`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: process.env.PLAID_CLIENT_ID,
      secret: process.env.PLAID_SECRET,
      access_token: process.env.PLAID_ACCESS_TOKEN,
    }),
  });

  const result = await response.json();
  console.log("[Plaid]", response.status, result.error_code ?? "ok");

  if (!response.ok || result.error_code) {
    return { ok: false, error: result.error_message ?? "Plaid error" };
  }

  // Use the highest available balance across depository accounts.
  const accounts: Array<{ type: string; balances: { available: number | null } }> =
    result.accounts ?? [];
  const depository = accounts.filter((a) => a.type === "depository");
  const verifiedBalance = depository.reduce(
    (max, a) => Math.max(max, a.balances.available ?? 0),
    0,
  );

  return { ok: true, balance: verifiedBalance };
}

const VALID_TYPES = ["kyc", "age", "income", "jurisdiction", "funds", "accreditation"];

const TYPE_TITLE: Record<string, string> = {
  kyc: "KYC Complete",
  age: "Age Verified",
  income: "Accredited (Income)",
  jurisdiction: "Jurisdiction Eligible",
  funds: "Proof of Funds",
  accreditation: "Accredited Investor (Net Worth)",
};

function buildClaimLabel(type: string, claimParams?: ClaimParams): string {
  switch (type) {
    case "age":
      return `age ≥ ${claimParams?.threshold_years ?? "18"}`;
    case "income": {
      const t = Number(claimParams?.threshold ?? "200000");
      return `income > $${t.toLocaleString("en-US")}`;
    }
    case "funds": {
      const t = Number(claimParams?.threshold ?? "10000");
      return `balance > $${t.toLocaleString("en-US")}`;
    }
    case "accreditation": {
      const t = Number(claimParams?.threshold ?? "1000000");
      return `net worth ≥ $${t.toLocaleString("en-US")}`;
    }
    case "jurisdiction":
      return "country not restricted";
    case "kyc":
    default:
      return "identity verified";
  }
}

interface ClaimParams {
  threshold_years?: string;
  threshold?: string;
  restricted?: string[];
}

interface IssueParams {
  type: string;
  holder: string;
  issuerId: string;
  issuerName: string;
  expiry: string;
  attributes: Record<string, string>;
  claimParams?: ClaimParams;
}

// Build one complete, independent credential for a single type. Each gets its
// own preimage/salt/commitment/signature — they share nothing but the issuer.
async function buildCredential({ type, holder, issuerId, issuerName, expiry, attributes, claimParams }: IssueParams) {
  const value = attributeToValue(type, attributes);
  const salt = randomField();
  const commitment = await poseidonCommit(value, salt);
  const { sig, issuerX, issuerY } = signCommitment(commitment);
  return {
    type,
    title: TYPE_TITLE[type],
    claim: buildClaimLabel(type, claimParams),
    issuer: issuerName,
    issuerId,
    holder,
    value,
    salt,
    commitment,
    sig,
    issuerPubX: issuerX,
    issuerPubY: issuerY,
    issuedAt: Math.floor(Date.now() / 1000),
    expiry,
    ...(claimParams && Object.values(claimParams).some((v) => v !== undefined) ? { claimParams } : {}),
  };
}

export async function POST(req: NextRequest) {
  const requestId = randomBytes(16).toString("hex");
  const startTime = Date.now();
  let outcome: "success" | "failure" = "failure";
  let credentialTypes: string[] = [];
  let issuerId: string | undefined;
  let walletAddress: string | undefined;

  const sendResponse = (response: NextResponse) => {
    const durationMs = Date.now() - startTime;
    response.headers.set("x-request-id", requestId);
    for (const type of credentialTypes) {
      logger.info(stripSensitiveFields({
        event: "response_sent",
        credentialType: type,
        issuerId,
        walletAddress,
        outcome,
        durationMs,
        requestId,
      }));
    }
    return response;
  };

  let body: {
    credential_types?: string[];
    // Legacy single-type shape — still accepted for backward compatibility.
    type?: string;
    holder?: string;
    issuerId?: string;
    issuerName?: string;
    expiry?: string;
    attributes?: Record<string, string>;
    attribute?: string;
    claimParams?: ClaimParams;
    // Set by the frontend after the user returns from Persona's hosted flow.
    persona_inquiry_id?: string;
    returnUrl?: string;
  };

  try {
    body = await req.json();
  } catch {
    return sendResponse(NextResponse.json({ error: "Invalid JSON" }, { status: 400 }));
  }

  const {
    holder,
    issuerId: reqIssuerId,
    issuerName = "StellarCred Authority",
    expiry = "90 days",
    claimParams,
    persona_inquiry_id: personaInquiryId,
    returnUrl,
  } = body;
  issuerId = reqIssuerId;
  walletAddress = holder;

  // Normalize to the multi-claim shape. Legacy callers send { type, attribute };
  // map that single attribute onto the right key in `attributes`.
  credentialTypes = body.credential_types ?? (body.type ? [body.type] : []);
  for (const type of credentialTypes) {
    logger.info(stripSensitiveFields({
      event: "request_received",
      credentialType: type,
      issuerId,
      walletAddress,
      requestId,
    }));
  }

  const attributes: Record<string, string> = { ...(body.attributes ?? {}) };
  if (body.attribute !== undefined && body.type) {
    if (body.type === "age") attributes.date_of_birth ??= body.attribute;
    else if (body.type === "income") attributes.income ??= body.attribute;
    else if (body.type === "jurisdiction") attributes.country_code ??= body.attribute;
  }

  if (credentialTypes.length === 0) {
    return sendResponse(NextResponse.json({ error: "credential_types must contain at least one type" }, { status: 400 }));
  }
  const invalid = credentialTypes.find((t) => !VALID_TYPES.includes(t));
  if (invalid) {
    for (const type of credentialTypes) {
      logger.info(stripSensitiveFields({
        event: "validation_result",
        credentialType: type,
        issuerId,
        walletAddress,
        outcome: "invalid_type",
        requestId,
      }));
    }
    return sendResponse(NextResponse.json({ error: `Invalid credential type: ${invalid}` }, { status: 400 }));
  }
  if (!holder) {
    return sendResponse(NextResponse.json({ error: "holder address is required" }, { status: 400 }));
  }
  if (!issuerId) {
    return sendResponse(NextResponse.json({ error: "issuerId is required" }, { status: 400 }));
  }

  // ---------------------------------------------------------------------------
  // Identity verification via Persona
  // ---------------------------------------------------------------------------
  // needsKyc = any of kyc / jurisdiction, OR age when KYC template is available
  // needsAgeOnly = age-only request when only the selfie age template is available
  //
  // Decision tree:
  //   PERSONA_API_KEY not set                           → demo fallback (always passes)
  //   PERSONA_API_KEY set, KYC types requested:
  //     PERSONA_KYC_TEMPLATE_ID not set                → 500 (misconfiguration)
  //     no inquiry_id yet                              → 202 + Persona URL (redirect)
  //     inquiry_id present                             → verify + extract DOB/country
  //   PERSONA_API_KEY set, age-only requested:
  //     PERSONA_AGE_TEMPLATE_ID not set                → 500 (misconfiguration)
  //     no inquiry_id yet                              → 202 + Persona URL (redirect)
  //     inquiry_id present                             → verify + extract min_age
  // ---------------------------------------------------------------------------
  // Gate the kyc credential on Persona identity verification (gov ID flow).
  // Age and jurisdiction are standalone — user-provided values, no external verification.
  // If PERSONA_API_KEY is not set → demo fallback, verification skipped.
  // If PERSONA_API_KEY is set but PERSONA_KYC_TEMPLATE_ID is missing → 500.
  const needsIdentity = credentialTypes.includes("kyc");
  if (needsIdentity) {
    if (!process.env.PERSONA_API_KEY) {
      logger.info(stripSensitiveFields({
        event: "provider_call",
        credentialType: "kyc",
        issuerId,
        walletAddress,
        outcome: "demo_mode",
        requestId,
      }));
    } else {
      const templateId = process.env.PERSONA_KYC_TEMPLATE_ID;
      if (!templateId) {
        return sendResponse(NextResponse.json(
          { error: "PERSONA_KYC_TEMPLATE_ID is required when PERSONA_API_KEY is set" },
          { status: 500 },
        ));
      }
      const baseUrl = process.env.NEXT_PUBLIC_STELLARCRED_BASE_URL ?? req.nextUrl.origin;
      if (!personaInquiryId) {
        // First request — create a Persona inquiry and ask the frontend to redirect.
        logger.info(stripSensitiveFields({
          event: "provider_call",
          credentialType: "kyc",
          issuerId,
          walletAddress,
          outcome: "inquiry_created",
          requestId,
        }));
        const redirectUrl = returnUrl
          ? `${baseUrl}/verify?return_url=${encodeURIComponent(returnUrl)}`
          : `${baseUrl}/verify`;
        const { url, id } = await createPersonaInquiry(templateId, redirectUrl);
        return sendResponse(NextResponse.json({ needsPersona: true, personaUrl: url, inquiryId: id }, { status: 202 }));
      }
      // Second request — user returned from Persona, verify the completed inquiry.
      const kyc = await resolvePersonaKYC(personaInquiryId);
      if (!kyc.ok) {
        logger.info(stripSensitiveFields({
          event: "provider_call",
          credentialType: "kyc",
          issuerId,
          walletAddress,
          outcome: "verification_failed",
          requestId,
        }));
        return sendResponse(NextResponse.json({ error: kyc.error ?? "Identity verification failed" }, { status: 403 }));
      }
      logger.info(stripSensitiveFields({
        event: "provider_call",
        credentialType: "kyc",
        issuerId,
        walletAddress,
        outcome: "verified",
        requestId,
      }));
      if (kyc.dob) attributes.date_of_birth = kyc.dob;
      if (kyc.countryNumeric) attributes.country_code = kyc.countryNumeric;
    }
  }

  // Gate funds issuance on Plaid balance attestation. Plaid is the source of
  // truth — we overwrite any user-supplied balance with the verified figure.
  const needsFunds = credentialTypes.includes("funds");
  if (needsFunds) {
    const plaid = await verifyWithPlaid();
    if (!plaid.ok) {
      logger.info(stripSensitiveFields({
        event: "provider_call",
        credentialType: "funds",
        issuerId,
        walletAddress,
        outcome: "verification_failed",
        requestId,
      }));
      return sendResponse(NextResponse.json(
        { error: plaid.error ?? "Balance verification failed" },
        { status: 403 },
      ));
    }
    logger.info(stripSensitiveFields({
      event: "provider_call",
      credentialType: "funds",
      issuerId,
      walletAddress,
      outcome: "verified",
      requestId,
    }));
    attributes.balance = String(plaid.balance ?? 0);
  }

  try {
    // De-duplicate types so the same claim isn't issued twice in one call.
    const uniqueTypes = Array.from(new Set(credentialTypes));
    const credentials = [];
    for (const type of uniqueTypes) {
      logger.info(stripSensitiveFields({
        event: "signing_started",
        credentialType: type,
        issuerId,
        walletAddress,
        requestId,
      }));
      const credential = await buildCredential({ type, holder, issuerId, issuerName, expiry, attributes, claimParams });
      credentials.push(credential);
      logger.info(stripSensitiveFields({
        event: "signing_success",
        credentialType: type,
        issuerId,
        walletAddress,
        requestId,
      }));
    }
    outcome = "success";
    return sendResponse(NextResponse.json({ credentials }));
  } catch (e) {
    for (const type of credentialTypes) {
      logger.error(stripSensitiveFields({
        event: "signing_failed",
        credentialType: type,
        issuerId,
        walletAddress,
        error: (e as Error).message,
        requestId,
      }));
    }
    return sendResponse(NextResponse.json({ error: (e as Error).message }, { status: 500 }));
  }
}
