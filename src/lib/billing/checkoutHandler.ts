// Request handling for POST /api/billing/checkout, kept apart from the route so it can be tested
// without a server. Server only.
import { billingEnabled } from "./accessCode";
import { createCheckoutSession, type FetchLike } from "./checkout";
import { findPlan } from "./plans";

export interface CheckoutReply {
  status: number;
  body: { url: string } | { error: string };
}

export async function handleCheckout(
  rawBody: unknown,
  ctx: {
    origin: string;
    env?: Record<string, string | undefined>;
    fetchImpl?: FetchLike;
  },
): Promise<CheckoutReply> {
  const env = ctx.env ?? process.env;
  if (!billingEnabled(env.SIGHTWORK_BILLING))
    return { status: 404, body: { error: "Not found." } };
  const plan = findPlan((rawBody as { plan?: unknown } | null)?.plan);
  if (!plan) return { status: 400, body: { error: "Pick a plan to buy." } };
  try {
    const s = await createCheckoutSession({
      plan,
      origin: ctx.origin,
      env,
      secretKey: env.STRIPE_SECRET_KEY,
      fetchImpl: ctx.fetchImpl,
    });
    return { status: 200, body: { url: s.url } };
  } catch (e) {
    // The detail stays in the server log; buyers get one plain line.
    console.error(
      JSON.stringify({
        event: "sightwork_checkout_failed",
        plan: plan.key,
        detail: String((e as Error).message),
      }),
    );
    return {
      status: 503,
      body: {
        error:
          "Checkout isn't available right now. Please try again in a few minutes.",
      },
    };
  }
}
