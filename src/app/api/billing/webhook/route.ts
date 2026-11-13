import { NextResponse, type NextRequest } from "next/server";
import { handleBillingWebhook } from "@/lib/billing/webhook";
import { sendPurchaseEmail } from "@/lib/billing/purchaseEmail";

/** POST /api/billing/webhook: Stripe's signed events. The raw body is what gets verified. 404 unless SIGHTWORK_BILLING=on. */
export async function POST(request: NextRequest) {
  const raw = await request.text();
  const r = handleBillingWebhook(raw, request.headers.get("stripe-signature"));
  // A verified, paid checkout: email the buyer their access code. Runs only after the signature check passed.
  if (r.status === 200 && "type" in r.body && r.body.type === "checkout.session.completed") {
    await sendPurchaseEmail(raw);
  }
  return NextResponse.json(r.body, { status: r.status, headers: { "Cache-Control": "no-store" } });
}
