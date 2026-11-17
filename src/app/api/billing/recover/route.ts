import { NextResponse, after, type NextRequest } from "next/server";
import { handleBillingRecover } from "@/lib/billing/recover";
import { recordUsage } from "@/lib/usage/store";

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
  // Anonymous count of access-code recovery requests (src/lib/usage); the email typed is never part of it.
  if (r.status === 200) after(() => recordUsage("recover_used", "", ""));
  return NextResponse.json(r.body, { status: r.status, headers: { "Cache-Control": "no-store" } });
}
