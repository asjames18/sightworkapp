// Stripe billing portal for an active subscription code. Server only. The code only says which
// subscription it belongs to; Stripe is asked for the customer and the status every time.
import { accessSecret, billingEnabled, verifyAccessCode } from "./accessCode";
import { STRIPE_API, type FetchLike } from "./checkout";

export interface PortalReply {
  status: number;
  body: { url: string } | { error: string };
}

type StripeFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => ReturnType<FetchLike>;

const PORTAL_STATUSES = new Set(["active", "trialing", "past_due"]);
const unavailable: PortalReply = {
  status: 503,
  body: { error: "Billing settings aren't available right now. Please try again in a few minutes." },
};

/** POST { code } in, { url } of Stripe's hosted billing portal out. Plan packs have nothing to manage. */
export async function handleBillingPortal(
  rawBody: unknown,
  ctx: { origin: string; env?: Record<string, string | undefined>; fetchImpl?: StripeFetch },
): Promise<PortalReply> {
  const env = ctx.env ?? process.env;
  if (!billingEnabled(env.SIGHTWORK_BILLING)) return { status: 404, body: { error: "Not found." } };
  if (!/^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(ctx.origin) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(ctx.origin)) {
    return unavailable;
  }
  const key = env.STRIPE_SECRET_KEY?.trim();
  const secret = accessSecret(env.SIGHTWORK_ACCESS_SECRET);
  if (!key || !/^(sk|rk)_(test|live)_[A-Za-z0-9]+$/.test(key) || !secret) {
    console.error(JSON.stringify({ event: "sightwork_billing_portal_failed", detail: "not configured" }));
    return unavailable;
  }
  const code = (rawBody as { code?: unknown } | null)?.code;
  const v = verifyAccessCode(typeof code === "string" ? code : null, { live: key.includes("_live_"), secret });
  if (!v.ok) return { status: 400, body: { error: "That access code isn't valid." } };
  if (v.grant.kind !== "sub") {
    return { status: 400, body: { error: "Plan packs have nothing to manage. Billing settings are for monthly and yearly plans." } };
  }
  try {
    const f = ctx.fetchImpl ?? (fetch as unknown as StripeFetch);
    const auth = { Authorization: `Bearer ${key}` };
    const subRes = await f(`${STRIPE_API}/subscriptions/${v.grant.stripeId}`, { method: "GET", headers: auth, body: "" });
    if (subRes.status === 404) return { status: 404, body: { error: "We couldn't find that subscription." } };
    if (!subRes.ok) throw new Error(`Stripe answered ${subRes.status}`);
    const sub = (await subRes.json()) as { customer?: unknown; status?: unknown };
    const customer = typeof sub.customer === "string" ? sub.customer : (sub.customer as { id?: unknown } | null)?.id;
    if (typeof customer !== "string" || !/^cus_[A-Za-z0-9]{6,64}$/.test(customer)) throw new Error("no customer on subscription");
    if (typeof sub.status !== "string" || !PORTAL_STATUSES.has(sub.status)) {
      return { status: 409, body: { error: "That subscription isn't active. Buy a plan again from the pricing page." } };
    }
    const res = await f(`${STRIPE_API}/billing_portal/sessions`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ customer, return_url: `${ctx.origin}/pricing` }).toString(),
    });
    if (!res.ok) throw new Error(`Stripe answered ${res.status} for the portal`);
    const j = (await res.json()) as { url?: unknown };
    if (typeof j.url !== "string" || !j.url.startsWith("https://billing.stripe.com/")) throw new Error("unexpected portal answer");
    return { status: 200, body: { url: j.url } };
  } catch (e) {
    console.error(JSON.stringify({ event: "sightwork_billing_portal_failed", detail: String((e as Error).message) }));
    return unavailable;
  }
}
