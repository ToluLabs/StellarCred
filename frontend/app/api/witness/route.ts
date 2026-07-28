import { NextRequest, NextResponse } from "next/server";
import type { InputMap } from "@noir-lang/noir_js";
import { logger, stripSensitiveFields, resolveRequestId } from "../../../lib/logger";
import ageCircuit from "../../../public/circuits/age.json";
import fundsCircuit from "../../../public/circuits/funds.json";
import incomeCircuit from "../../../public/circuits/income.json";
import jurisdictionCircuit from "../../../public/circuits/jurisdiction.json";
import kycCircuit from "../../../public/circuits/kyc.json";
import accreditationCircuit from "../../../public/circuits/accreditation.json";

// Default claim params — used when a credential has no protocol-specific values.
const DEFAULT_THRESHOLD_YEARS = "18";
const DEFAULT_INCOME_THRESHOLD = "200000";
const DEFAULT_FUNDS_THRESHOLD = "10000";
const DEFAULT_ACCREDITATION_THRESHOLD = "1000000";
const DEFAULT_RESTRICTED = ["840", "364", "408", "0", "0", "0", "0", "0"];

const RESTRICTED_LEN = 8;

function normalizeRestricted(list: string[]): string[] {
  // The circuit expects exactly RESTRICTED_LEN entries; pad with "0".
  const trimmed = list.slice(0, RESTRICTED_LEN);
  while (trimmed.length < RESTRICTED_LEN) trimmed.push("0");
  return trimmed;
}

interface ClaimParams {
  threshold_years?: string;
  threshold?: string;
  restricted?: string[];
}

function buildInputs(type: string, cred: Record<string, unknown>): InputMap {
  const value = String(cred.value);
  const salt = String(cred.salt);
  const commitment = String(cred.commitment);
  const params = (cred.claimParams ?? {}) as ClaimParams;
  const sigInputs = {
    sig: cred.sig as number[],
    issuer_x: cred.issuerPubX as number[],
    issuer_y: cred.issuerPubY as number[],
  };
  switch (type) {
    case "age":
      return {
        date_of_birth: value,
        salt,
        ...sigInputs,
        commitment,
        current_date: String(Math.floor(Date.now() / 86_400_000)),
        threshold_years: params.threshold_years ?? DEFAULT_THRESHOLD_YEARS,
      };
    case "income":
      return {
        income: value,
        salt,
        ...sigInputs,
        commitment,
        threshold: params.threshold ?? DEFAULT_INCOME_THRESHOLD,
      };
    case "jurisdiction":
      return {
        country_code: value,
        salt,
        ...sigInputs,
        commitment,
        restricted: normalizeRestricted(params.restricted ?? DEFAULT_RESTRICTED),
      };
    case "funds":
      return {
        balance: value,
        salt,
        ...sigInputs,
        commitment,
        threshold: params.threshold ?? DEFAULT_FUNDS_THRESHOLD,
      };
    case "accreditation":
      return {
        net_worth: value,
        salt,
        ...sigInputs,
        commitment,
        threshold: params.threshold ?? DEFAULT_ACCREDITATION_THRESHOLD,
      };
    case "kyc":
    default:
      return { secret: value, salt, ...sigInputs, commitment };
  }
}

function circuitFor(type: string) {
  switch (type) {
    case "age": return ageCircuit;
    case "funds": return fundsCircuit;
    case "accreditation": return accreditationCircuit;
    case "income": return incomeCircuit;
    case "jurisdiction": return jurisdictionCircuit;
    case "kyc":
    default: return kycCircuit;
  }
}

export async function POST(req: NextRequest) {
  const requestId = resolveRequestId(req.headers.get("x-request-id"));

  const sendResponse = (response: NextResponse) => {
    response.headers.set("x-request-id", requestId);
    return response;
  };

  let body: { type?: string; credential?: Record<string, unknown> };
  try {
    body = await req.json();
  } catch {
    return sendResponse(NextResponse.json({ error: "Invalid JSON" }, { status: 400 }));
  }

  const { type, credential } = body;
  if (!type || !credential) {
    return sendResponse(NextResponse.json({ error: "type and credential are required" }, { status: 400 }));
  }

  logger.info(stripSensitiveFields({ event: "witness_request_received", credentialType: type, requestId }));

  try {
    const { Noir } = await import("@noir-lang/noir_js");
    const circuit = circuitFor(type);
    const noir = new Noir(circuit as never);
    const inputs = buildInputs(type, credential);
    const { witness } = await noir.execute(inputs);
    // Serialize Uint8Array → hex string for JSON transport.
    const hex = Buffer.from(witness).toString("hex");
    logger.info(stripSensitiveFields({
      event: "witness_response_sent",
      credentialType: type,
      outcome: "success",
      requestId,
    }));
    return sendResponse(NextResponse.json({ witness: hex }));
  } catch (e) {
    logger.error(stripSensitiveFields({
      event: "witness_response_sent",
      credentialType: type,
      outcome: "failure",
      error: (e as Error).message,
      requestId,
    }));
    return sendResponse(NextResponse.json({ error: (e as Error).message }, { status: 500 }));
  }
}
