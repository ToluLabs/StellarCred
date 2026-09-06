import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const INDEXER_URL = process.env.INDEXER_URL ?? "http://localhost:3001";

const VALID_CLAIM_TYPES = new Set([
  "kyc",
  "age",
  "jurisdiction",
  "income",
  "funds",
  "accreditation",
  "employment",
]);

const MAX_APP_NAME = 120;
const MAX_DESCRIPTION = 2000;
const MAX_CLAIMS = 10;

function validateUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { appName, description, requiredClaims, verifyUrl, contactEmail } = body;

    if (typeof appName !== "string" || appName.trim().length === 0) {
      return NextResponse.json({ error: "appName is required" }, { status: 400 });
    }
    if (appName.trim().length > MAX_APP_NAME) {
      return NextResponse.json(
        { error: `appName must be at most ${MAX_APP_NAME} characters` },
        { status: 400 }
      );
    }

    if (typeof description !== "string" || description.trim().length === 0) {
      return NextResponse.json({ error: "description is required" }, { status: 400 });
    }
    if (description.trim().length > MAX_DESCRIPTION) {
      return NextResponse.json(
        { error: `description must be at most ${MAX_DESCRIPTION} characters` },
        { status: 400 }
      );
    }

    if (!Array.isArray(requiredClaims) || requiredClaims.length === 0) {
      return NextResponse.json(
        { error: "requiredClaims must be a non-empty array" },
        { status: 400 }
      );
    }
    if (requiredClaims.length > MAX_CLAIMS) {
      return NextResponse.json(
        { error: `requiredClaims must contain at most ${MAX_CLAIMS} items` },
        { status: 400 }
      );
    }
    for (const claim of requiredClaims) {
      if (typeof claim !== "string" || !VALID_CLAIM_TYPES.has(claim)) {
        return NextResponse.json(
          {
            error: `invalid claim type: "${claim}". Valid types: ${[...VALID_CLAIM_TYPES].join(", ")}`,
          },
          { status: 400 }
        );
      }
    }

    if (typeof verifyUrl !== "string" || verifyUrl.trim().length === 0) {
      return NextResponse.json({ error: "verifyUrl is required" }, { status: 400 });
    }
    if (!validateUrl(verifyUrl.trim())) {
      return NextResponse.json(
        { error: "verifyUrl must be a valid http or https URL" },
        { status: 400 }
      );
    }

    if (typeof contactEmail !== "string" || contactEmail.trim().length === 0) {
      return NextResponse.json({ error: "contactEmail is required" }, { status: 400 });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail.trim())) {
      return NextResponse.json(
        { error: "contactEmail must be a valid email address" },
        { status: 400 }
      );
    }

    const res = await fetch(`${INDEXER_URL}/apps/submit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        appName: appName.trim(),
        description: description.trim(),
        requiredClaims: requiredClaims.map((c: string) => c.trim()),
        verifyUrl: verifyUrl.trim(),
        contactEmail: contactEmail.trim(),
      }),
      signal: AbortSignal.timeout(10000),
    });

    const data = await res.json();

    if (!res.ok) {
      return NextResponse.json(data, { status: res.status });
    }

    return NextResponse.json(data, { status: 201 });
  } catch (err) {
    if (err instanceof SyntaxError) {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }
    return NextResponse.json(
      { error: "Submission service unavailable. Please try again later." },
      { status: 503 }
    );
  }
}
