import { NextResponse, type NextRequest } from "next/server";
import { handleBillingRecover } from "@/lib/billing/recover";

/** POST /api/billing/recover: { email } in, a plain "if found, we emailed it" answer out. 404 unless SIGHTWORK_BILLING=on. */
export async function POST(request: NextRequest) {
  let body: unknown = null;
  if ((request.headers.get("content-type") ?? "").includes("application/json")) {
    try {
      body = await request.json();
    } catch {
      body = null;
    }
  }
  const r = await handleBillingRecover(body, {});
  return NextResponse.json(r.body, { status: r.status, headers: { "Cache-Control": "no-store" } });
}
