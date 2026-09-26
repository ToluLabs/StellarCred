// Server-side only — never shipped to the browser.
if (typeof window !== "undefined") {
  throw new Error("lib/persona.ts is server-only and must not be imported from client code.");
}

import { env } from "./env";

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

export async function createPersonaInquiry(
  templateId: string,
  redirectUri: string,
  referenceId?: string,
): Promise<{ url: string; id: string }> {
  const res = await fetch(`${PERSONA_BASE}/inquiries`, {
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
  const json = await res.json();
  if (!res.ok) {
    throw new Error(
      `Persona: failed to create inquiry — ${JSON.stringify(json)}`,
    );
  }
  const id: string = json.data.id;
  const url = `https://withpersona.com/verify?inquiry-id=${id}`;
  return { url, id };
}

export async function retrievePersonaInquiry(inquiryId: string): Promise<{
  status: string;
  fields: Record<string, { value: unknown }>;
}> {
  const res = await fetch(`${PERSONA_BASE}/inquiries/${inquiryId}`, {
    headers: personaHeaders(),
  });
  const json = await res.json();
  if (!res.ok) {
    throw new Error(
      `Persona: failed to retrieve inquiry — ${JSON.stringify(json)}`,
    );
  }
  return {
    status: json.data.attributes.status as string,
    fields: (json.data.attributes.fields ?? {}) as Record<
      string,
      { value: unknown }
    >,
  };
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
}> {
  const { status, fields } = await retrievePersonaInquiry(inquiryId);
  if (status !== "approved") {
    return { ok: false, error: `Persona KYC inquiry status: ${status}` };
  }
  const dob =
    String(
      fields["birthdate"]?.value ?? fields["birth-date"]?.value ?? "",
    ).trim() || undefined;
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
