import { NextResponse } from "next/server";
import { checkAuthDatabase } from "@/server/database";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    await checkAuthDatabase();
    return NextResponse.json(
      { status: "ready", service: "infinity-auth" },
      { headers: { "cache-control": "no-store" } },
    );
  } catch {
    return NextResponse.json(
      { status: "not-ready", service: "infinity-auth" },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
}
