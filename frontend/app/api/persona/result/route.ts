import { NextRequest, NextResponse } from "next/server";
import { getInquiryResult, getPendingInquiry } from "@/lib/persona-webhook";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const searchParams = req.nextUrl.searchParams;
  const inquiryId =
    searchParams.get("inquiry_id") || searchParams.get("inquiry-id");

  if (!inquiryId) {
    return NextResponse.json(
      { error: "inquiry_id query parameter is required" },
      { status: 400 },
    );
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
    return NextResponse.json(
      {
        ready: false,
        status: "failed",
        error: result.error ?? "Identity verification failed",
      },
      { status: 200 },
    );
  }

  const pending = getPendingInquiry(inquiryId);
  if (pending) {
    return NextResponse.json(
      { ready: false, status: "pending" },
      { status: 200 },
    );
  }

  return NextResponse.json(
    { ready: false, status: "pending" },
    { status: 200 },
  );
}
