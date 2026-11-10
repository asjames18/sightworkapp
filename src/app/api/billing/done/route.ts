import { NextResponse, type NextRequest } from "next/server";
import { handleBillingDone } from "@/lib/billing/session";

/** POST /api/billing/done: { sessionId } in, { code, kind, plan } out once Stripe says it's paid. 404 unless SIGHTWORK_BILLING=on. */
export async function POST(request: NextRequest) {
  let body: unknown = null;
  if ((request.headers.get("content-type") ?? "").includes("application/json")) {
    try {
      body = await request.json();
    } catch {
      body = null;
    }
  }
  const r = await handleBillingDone(body, {});
  return NextResponse.json(r.body, { status: r.status, headers: { "Cache-Control": "no-store" } });
}
