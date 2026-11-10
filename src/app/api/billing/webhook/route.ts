import { NextResponse, type NextRequest } from "next/server";
import { handleBillingWebhook } from "@/lib/billing/webhook";

/** POST /api/billing/webhook: Stripe's signed events. The raw body is what gets verified. 404 unless SIGHTWORK_BILLING=on. */
export async function POST(request: NextRequest) {
  const raw = await request.text();
  const r = handleBillingWebhook(raw, request.headers.get("stripe-signature"));
  return NextResponse.json(r.body, { status: r.status, headers: { "Cache-Control": "no-store" } });
}
