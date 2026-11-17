import { NextResponse, after, type NextRequest } from "next/server";
import { handleCheckout } from "@/lib/billing/checkoutHandler";
import { recordUsage } from "@/lib/usage/store";
import { usageDetail } from "@/lib/usage/events";

/** POST /api/billing/checkout: { plan, email } in, { url } of Stripe's hosted Checkout out. 404 unless SIGHTWORK_BILLING=on. */
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
  // Anonymous count of checkouts opened, by plan only (src/lib/usage). The email is never part of it.
  if (r.status === 200) {
    const plan = usageDetail("checkout_started", (body as { plan?: unknown } | null)?.plan) ?? "";
    after(() => recordUsage("checkout_started", plan, ""));
  }
  return NextResponse.json(r.body, {
    status: r.status,
    headers: { "Cache-Control": "no-store" },
  });
}
