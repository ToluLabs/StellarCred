import { NextRequest, NextResponse } from "next/server";
import { getInquiryResult, getPendingInquiry } from "@/lib/persona-webhook";
import { classifyVerificationError } from "@/packages/sdk/src/errors";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const searchParams = req.nextUrl.searchParams;
  const inquiryId = searchParams.get("inquiry_id") || searchParams.get("inquiry-id");

  if (!inquiryId) {
    return NextResponse.json({ error: "inquiry_id query parameter is required" }, { status: 400 });
  }

  const result = getInquiryResult(inquiryId);
  if (result) {
    if (result.status === "completed") {
      return NextResponse.json(
        {
          ready: true,
          status: "completed",
          credentials: result.credentials ?? [],
        },
        { status: 200 },
      );
    }
    const error = classifyVerificationError(
      {
        category: result.errorCategory,
        code: result.errorCode,
        message: result.error,
      },
      {
        fallbackCategory: "policy_rejection",
        fallbackCode: "persona_incomplete",
      },
    );
    return NextResponse.json(
      {
        ready: false,
        status: "failed",
        error: error.message,
        category: error.category,
        code: error.code,
        retryable: error.retryable,
      },
      { status: 200 },
    );
  }

  const pending = getPendingInquiry(inquiryId);
  if (pending) {
    return NextResponse.json({ ready: false, status: "pending" }, { status: 200 });
  }

  return NextResponse.json({ ready: false, status: "pending" }, { status: 200 });
}
