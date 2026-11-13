// Is this access code still worth a run? Server only. The code's signature says which Stripe
// subscription it belongs to; Stripe says whether that subscription is paid up right now.
// A pack code is good while the customer has used fewer plans than they bought: plans bought
// are summed from the customer's paid Checkout sessions, plans used from the counter that
// recordPackUse keeps on the customer (packUse.ts). Stripe stays the only record, so a
// redelivered webhook can never add credits twice. The Stripe id comes back with an allowed
// result so the caller can record the finished plan.
import { accessSecret, billingEnabled, verifyAccessCode } from "./accessCode";
import { STRIPE_API } from "./checkout";
import { plansBought, plansUsed } from "./packUse";

type GetLike = (url: string, init: { method: string; headers: Record<string, string> }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

export type Entitlement =
  | { allowed: true; kind: "pack" | "sub"; stripeId: string }
  | { allowed: false; reason: "off" | "invalid" | "inactive" | "used-up" | "unavailable" };

export async function checkEntitlement(
  code: string | null | undefined,
  ctx: { env?: Record<string, string | undefined>; fetchImpl?: GetLike } = {},
): Promise<Entitlement> {
  const env = ctx.env ?? process.env;
  if (!billingEnabled(env.SIGHTWORK_BILLING)) return { allowed: false, reason: "off" };
  const key = env.STRIPE_SECRET_KEY?.trim();
  const secret = accessSecret(env.SIGHTWORK_ACCESS_SECRET);
  if (!key || !/^(sk|rk)_(test|live)_[A-Za-z0-9]+$/.test(key) || !secret) return { allowed: false, reason: "unavailable" };
  const v = verifyAccessCode(code, { live: key.includes("_live_"), secret });
  if (!v.ok) return { allowed: false, reason: "invalid" };
  try {
    const f = ctx.fetchImpl ?? (fetch as unknown as GetLike);
    const path = v.grant.kind === "sub" ? `/subscriptions/${v.grant.stripeId}` : `/customers/${v.grant.stripeId}`;
    const res = await f(`${STRIPE_API}${path}`, { method: "GET", headers: { Authorization: `Bearer ${key}` } });
    if (res.status === 404) return { allowed: false, reason: "inactive" };
    if (!res.ok) return { allowed: false, reason: "unavailable" };
    const j = (await res.json()) as { status?: unknown; deleted?: unknown; metadata?: unknown };
    if (v.grant.kind === "sub") {
      return j.status === "active" || j.status === "trialing" ? { allowed: true, kind: "sub", stripeId: v.grant.stripeId } : { allowed: false, reason: "inactive" };
    }
    if (j.deleted === true) return { allowed: false, reason: "inactive" };
    const used = plansUsed(j.metadata);
    let bought = 0;
    let after = "";
    // A customer with more than 500 checkouts is far past any real pack; stop paging there.
    for (let page = 0; page < 5 && bought <= used; page++) {
      const q = new URLSearchParams([["customer", v.grant.stripeId], ["status", "complete"], ["limit", "100"]]);
      if (after) q.set("starting_after", after);
      const list = await f(`${STRIPE_API}/checkout/sessions?${q.toString()}`, { method: "GET", headers: { Authorization: `Bearer ${key}` } });
      if (!list.ok) return { allowed: false, reason: "unavailable" };
      const l = (await list.json()) as { data?: unknown; has_more?: unknown };
      bought += plansBought(l.data);
      const data = Array.isArray(l.data) ? (l.data as Array<{ id?: unknown }>) : [];
      const last = data[data.length - 1]?.id;
      if (l.has_more !== true || typeof last !== "string") break;
      after = last;
    }
    return used < bought ? { allowed: true, kind: "pack", stripeId: v.grant.stripeId } : { allowed: false, reason: "used-up" };
  } catch {
    return { allowed: false, reason: "unavailable" };
  }
}
