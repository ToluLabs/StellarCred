import { NextRequest, NextResponse } from "next/server";
import { reviewApp } from "@/lib/apps-store";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { id, status } = body ?? {};

    if (!id || (status !== "approved" && status !== "rejected" && status !== "pending")) {
      return NextResponse.json(
        { error: "id and valid status (approved | rejected | pending) are required" },
        { status: 400 },
      );
    }

    const updated = await reviewApp(Number(id), status);
    if (!updated) {
      return NextResponse.json({ error: "app not found" }, { status: 404 });
    }

    return NextResponse.json({ app: updated });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
