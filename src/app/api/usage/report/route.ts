import { NextResponse, type NextRequest } from "next/server";
import { handleUsageReport } from "@/lib/usage/handler";

/** POST /api/usage/report: { key, days } in, daily totals out. 404 unless the counts and the view key are set up. */
export async function POST(request: NextRequest) {
  let body: unknown = null;
  if ((request.headers.get("content-type") ?? "").includes("application/json")) {
    try {
      body = await request.json();
    } catch {
      body = null;
    }
  }
  const r = await handleUsageReport(body);
  return NextResponse.json(r.body, { status: r.status, headers: { "Cache-Control": "no-store" } });
}
