// Server-side only — never shipped to the browser.
if (typeof window !== "undefined") {
  throw new Error("lib/persona.ts is server-only and must not be imported from client code.");
}

import { env } from "./env";
import {
  VerificationError,
  type VerificationErrorCategory,
  type VerificationErrorCode,
} from "../packages/sdk/src/errors";

export const PERSONA_BASE = "https://withpersona.com/api/v1";
export const PERSONA_VERSION = "2023-01-05";

// Minimal ISO 3166-1 alpha-2 → numeric map for countries we care about.
// Persona returns alpha-2 codes; our jurisdiction circuit uses numeric.
export const ALPHA2_TO_NUMERIC: Record<string, string> = {
  NG: "566",
  US: "840",
  DE: "276",
  IN: "356",
  IR: "364",
  GB: "826",
  FR: "250",
  CA: "124",
  AU: "036",
  BR: "076",
  CN: "156",
  JP: "392",
  KR: "410",
  ZA: "710",
  GH: "288",
  KE: "404",
  EG: "818",
  MX: "484",
  AR: "032",
  SG: "702",
};

export function alpha2ToNumeric(code: string): string {
  return ALPHA2_TO_NUMERIC[code.toUpperCase()] ?? "0";
}

export function personaHeaders() {
  return {
    Authorization: `Bearer ${env.PERSONA_API_KEY}`,
    "Content-Type": "application/json",
    "Persona-Version": PERSONA_VERSION,
  };
}

async function responseObject(res: Response, code: string): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await res.json();
  } catch (cause) {
    throw new VerificationError({
      category: res.ok ? "configuration_error" : "network_error",
      code,
      httpStatus: res.ok ? 502 : res.status,
      cause,
    });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new VerificationError({
      category: res.ok ? "configuration_error" : "network_error",
      code,
      httpStatus: res.ok ? 502 : res.status,
    });
  }
  return body as Record<string, unknown>;
}

async function personaFetch(input: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(input, init);
  } catch (cause) {
    throw new VerificationError({
      category: "network_error",
      code: "persona_unavailable",
      httpStatus: 502,
      cause,
    });
  }
}

export async function createPersonaInquiry(
  templateId: string,
  redirectUri: string,
  referenceId?: string,
): Promise<{ url: string; id: string }> {
  const res = await personaFetch(`${PERSONA_BASE}/inquiries`, {
    method: "POST",
    headers: personaHeaders(),
    body: JSON.stringify({
      data: {
        attributes: {
          "inquiry-template-id": templateId,
          "redirect-uri": redirectUri,
          ...(referenceId ? { "reference-id": referenceId } : {}),
        },
      },
    }),
  });
  const body = await responseObject(res, "persona_invalid_response");
  if (!res.ok) {
    throw new VerificationError({
      category:
        res.status === 401 || res.status === 403
          ? "configuration_error"
          : res.status >= 500 || res.status === 408 || res.status === 429
            ? "network_error"
            : "invalid_input",
      code: `persona_create_http_${res.status}`,
      httpStatus: res.status,
    });
  }
  const data = body.data as Record<string, unknown> | undefined;
  const id = data?.id;
  if (typeof id !== "string" || id.length === 0) {
    throw new VerificationError({
      category: "configuration_error",
      code: "persona_invalid_response",
      httpStatus: 502,
    });
  }
  const url = `https://withpersona.com/verify?inquiry-id=${encodeURIComponent(id)}`;
  return { url, id };
}

export async function retrievePersonaInquiry(inquiryId: string): Promise<{
  status: string;
  fields: Record<string, { value: unknown }>;
}> {
  const res = await personaFetch(`${PERSONA_BASE}/inquiries/${encodeURIComponent(inquiryId)}`, {
    headers: personaHeaders(),
  });
  const body = await responseObject(res, "persona_invalid_response");
  if (!res.ok) {
    throw new VerificationError({
      category:
        res.status === 401 || res.status === 403
          ? "configuration_error"
          : res.status >= 500 || res.status === 408 || res.status === 429
            ? "network_error"
            : "invalid_input",
      code: `persona_retrieve_http_${res.status}`,
      httpStatus: res.status,
    });
  }
  const data = body.data as Record<string, unknown> | undefined;
  const attributes = data?.attributes as Record<string, unknown> | undefined;
  const status = attributes?.status;
  const fields = attributes?.fields ?? {};
  if (
    typeof status !== "string" ||
    status.length === 0 ||
    !fields ||
    typeof fields !== "object" ||
    Array.isArray(fields)
  ) {
    throw new VerificationError({
      category: "configuration_error",
      code: "persona_invalid_response",
      httpStatus: 502,
    });
  }
  return {
    status,
    fields: fields as Record<string, { value: unknown }>,
  };
}

function personaFailure(status: string): VerificationError {
  const category: VerificationErrorCategory =
    status === "declined" || status === "failed" ? "policy_rejection" : "invalid_input";
  const code: VerificationErrorCode =
    status === "declined"
      ? "persona_declined"
      : status === "expired"
        ? "persona_expired"
        : status === "failed"
          ? "persona_incomplete"
          : "persona_incomplete";
  return new VerificationError({ category, code, httpStatus: 403 });
}

/**
 * Called after user returns from Persona KYC (gov ID) inquiry.
 * Returns DOB and country so we can issue age + jurisdiction credentials.
 */
export async function resolvePersonaKYC(inquiryId: string): Promise<{
  ok: boolean;
  dob?: string;
  countryNumeric?: string;
  error?: string;
  errorCategory?: VerificationErrorCategory;
  errorCode?: VerificationErrorCode;
}> {
  const { status, fields } = await retrievePersonaInquiry(inquiryId);
  if (status !== "approved") {
    const error = personaFailure(status);
    return {
      ok: false,
      error: error.message,
      errorCategory: error.category,
      errorCode: error.code,
    };
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
