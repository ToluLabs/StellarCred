import { NextRequest, NextResponse } from "next/server";
import { submitApp, validateSubmission } from "@/lib/apps-store";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const validation = validateSubmission(body);
    if (!validation.valid) {
      const firstError = Object.values(validation.errors)[0];
      return NextResponse.json({ error: firstError }, { status: 400 });
    }

    const result = await submitApp({
      appName: body.appName,
      description: body.description,
      requiredClaims: body.requiredClaims,
      verifyUrl: body.verifyUrl,
      contactEmail: body.contactEmail,
    });

    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    if (err instanceof SyntaxError) {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }
    return NextResponse.json(
      { error: (err as Error).message || "Submission failed" },
      { status: 500 }
    );
  }
}
