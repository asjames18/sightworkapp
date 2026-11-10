// Builds and creates Stripe hosted Checkout sessions over the Stripe REST API with fetch,
// so SightWork needs no Stripe library. Server only. The secret key comes from STRIPE_SECRET_KEY.
import { planPriceId, type PaidPlan } from "./plans";

export const STRIPE_API = "https://api.stripe.com/v1";

export interface CheckoutInput {
  plan: PaidPlan;
  /** Absolute origin of this site, e.g. https://sightwork.vercel.app (no trailing slash). */
  origin: string;
  env?: Record<string, string | undefined>;
}

/** The form fields for POST /v1/checkout/sessions, in order. Throws when the plan can't be sold. */
export function buildCheckoutParams({ plan, origin, env = process.env }: CheckoutInput): [string, string][] {
  const price = planPriceId(plan, env);
  if (!price) throw new Error(`checkout: no Stripe price is set for ${plan.key}`);
  if (!/^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(origin) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
    throw new Error("checkout: origin must be this site's https address");
  }
  const p: [string, string][] = [
    ["mode", plan.mode],
    ["line_items[0][price]", price],
    ["line_items[0][quantity]", "1"],
    // {CHECKOUT_SESSION_ID} is filled in by Stripe; the return page checks the session server-side.
    ["success_url", `${origin}/billing/done?session_id={CHECKOUT_SESSION_ID}`],
    ["cancel_url", `${origin}/pricing`],
    ["metadata[sightwork_plan]", plan.key],
    ["billing_address_collection", "auto"],
  ];
  if (plan.mode === "payment") {
    // A Stripe customer holds a pack's credits, so always make one.
    p.push(["customer_creation", "always"]);
    p.push(["payment_intent_data[metadata][sightwork_plan]", plan.key]);
  } else {
    p.push(["subscription_data[metadata][sightwork_plan]", plan.key]);
  }
  // Nonprofit discount codes are for yearly plans only.
  if (plan.yearly) p.push(["allow_promotion_codes", "true"]);
  return p;
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

/** Creates the session and returns Stripe's hosted page URL. Never returns Stripe's raw error text. */
export async function createCheckoutSession(
  input: CheckoutInput & { secretKey: string | undefined; fetchImpl?: FetchLike },
): Promise<{ id: string; url: string }> {
  const key = input.secretKey?.trim();
  if (!key || !/^(sk|rk)_(test|live)_[A-Za-z0-9]+$/.test(key)) throw new Error("checkout: the Stripe key is not set");
  const body = new URLSearchParams(buildCheckoutParams(input)).toString();
  const f = input.fetchImpl ?? (fetch as unknown as FetchLike);
  const res = await f(`${STRIPE_API}/checkout/sessions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) throw new Error(`checkout: Stripe answered ${res.status}`);
  const j = (await res.json()) as { id?: unknown; url?: unknown };
  if (typeof j.id !== "string" || typeof j.url !== "string" || !j.url.startsWith("https://checkout.stripe.com/")) {
    throw new Error("checkout: Stripe sent an unexpected answer");
  }
  return { id: j.id, url: j.url };
}
