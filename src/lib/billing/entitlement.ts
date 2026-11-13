// Is this access code still worth a run? Server only. The code's signature says which Stripe
// subscription it belongs to; Stripe says whether that subscription is paid up right now.
// Plan packs are not counted here yet: a pack code only proves a paid customer. The Stripe id
// comes back with an allowed result so the caller can record a finished pack plan (packUse.ts).
import { accessSecret, billingEnabled, verifyAccessCode } from "./accessCode";
import { STRIPE_API } from "./checkout";

type GetLike = (url: string, init: { method: string; headers: Record<string, string> }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

export type Entitlement =
  | { allowed: true; kind: "pack" | "sub"; stripeId: string }
  | { allowed: false; reason: "off" | "invalid" | "inactive" | "unavailable" };

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
    const j = (await res.json()) as { status?: unknown; deleted?: unknown };
    if (v.grant.kind === "sub") {
      return j.status === "active" || j.status === "trialing" ? { allowed: true, kind: "sub", stripeId: v.grant.stripeId } : { allowed: false, reason: "inactive" };
    }
    return j.deleted === true ? { allowed: false, reason: "inactive" } : { allowed: true, kind: "pack", stripeId: v.grant.stripeId };
  } catch {
    return { allowed: false, reason: "unavailable" };
  }
}
