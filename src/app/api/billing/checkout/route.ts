import { NextResponse, type NextRequest } from "next/server";
import { handleCheckout } from "@/lib/billing/checkoutHandler";

/** POST /api/billing/checkout: { plan } in, { url } of Stripe's hosted Checkout out. 404 unless SIGHTWORK_BILLING=on. */
export async function POST(request: NextRequest) {
  let body: unknown = null;
  if (
    (request.headers.get("content-type") ?? "").includes("application/json")
  ) {
    try {
      body = await request.json();
    } catch {
      body = null;
    }
  }
  const r = await handleCheckout(body, { origin: request.nextUrl.origin });
  return NextResponse.json(r.body, {
    status: r.status,
    headers: { "Cache-Control": "no-store" },
  });
}
