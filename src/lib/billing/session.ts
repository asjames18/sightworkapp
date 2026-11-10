// Checks a Stripe Checkout session when the buyer comes back, and turns a paid one into an access
// code. Server only. Stripe is asked directly with the secret key, so the session id in the address
// bar is only a lookup key: nothing is trusted from the browser.
import { accessSecret, billingEnabled, issueAccessCode, type AccessGrant } from "./accessCode";
import { STRIPE_API, type FetchLike } from "./checkout";
import { findPlan } from "./plans";

const SESSION_ID = /^cs_(test|live)_[A-Za-z0-9]{6,200}$/;

export interface DoneReply {
  status: number;
  body: { code: string; kind: "pack" | "sub"; plan: string } | { error: string; pending?: boolean };
}

type GetLike = (url: string, init: { method: string; headers: Record<string, string> }) => ReturnType<FetchLike>;

const idOf = (v: unknown): string | null =>
  typeof v === "string" ? v : v && typeof v === "object" && typeof (v as { id?: unknown }).id === "string" ? (v as { id: string }).id : null;

/** Looks up the session and, when it is paid, answers with a signed access code. */
export async function handleBillingDone(
  rawBody: unknown,
  ctx: { env?: Record<string, string | undefined>; fetchImpl?: GetLike; now?: () => number },
): Promise<DoneReply> {
  const env = ctx.env ?? process.env;
  if (!billingEnabled(env.SIGHTWORK_BILLING)) return { status: 404, body: { error: "Not found." } };
  const sid = (rawBody as { sessionId?: unknown } | null)?.sessionId;
  if (typeof sid !== "string" || !SESSION_ID.test(sid)) {
    return { status: 400, body: { error: "This link isn't a valid purchase link." } };
  }
  const key = env.STRIPE_SECRET_KEY?.trim();
  const secret = accessSecret(env.SIGHTWORK_ACCESS_SECRET);
  const unavailable: DoneReply = {
    status: 503,
    body: { error: "We can't confirm your purchase right now. Please refresh in a few minutes." },
  };
  if (!key || !/^(sk|rk)_(test|live)_[A-Za-z0-9]+$/.test(key) || !secret) {
    console.error(JSON.stringify({ event: "sightwork_billing_done_failed", detail: "not configured" }));
    return unavailable;
  }
  try {
    const f = ctx.fetchImpl ?? (fetch as unknown as GetLike);
    const res = await f(`${STRIPE_API}/checkout/sessions/${sid}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${key}` },
    });
    if (res.status === 404) return { status: 404, body: { error: "We couldn't find that purchase." } };
    if (!res.ok) throw new Error(`Stripe answered ${res.status}`);
    const s = (await res.json()) as Record<string, unknown>;
    const meta = (s.metadata ?? {}) as { sightwork_plan?: unknown };
    const plan = findPlan(meta.sightwork_plan);
    if (!plan || typeof s.livemode !== "boolean") throw new Error("session is not a SightWork purchase");
    if (plan.mode !== s.mode) throw new Error("session mode does not match plan");

    let grant: AccessGrant | null = null;
    if (s.mode === "payment" && s.payment_status === "paid") {
      const cus = idOf(s.customer);
      if (cus) grant = { kind: "pack", stripeId: cus, live: s.livemode, issuedAt: 0 };
    } else if (s.mode === "subscription" && s.status === "complete" && (s.payment_status === "paid" || s.payment_status === "no_payment_required")) {
      const sub = idOf(s.subscription);
      if (sub) grant = { kind: "sub", stripeId: sub, live: s.livemode, issuedAt: 0 };
    }
    if (!grant) {
      return { status: 202, body: { error: "Your payment hasn't gone through yet.", pending: true } };
    }
    grant.issuedAt = Math.floor((ctx.now ?? Date.now)() / 1000);
    return { status: 200, body: { code: issueAccessCode(grant, secret), kind: grant.kind, plan: plan.name } };
  } catch (e) {
    console.error(JSON.stringify({ event: "sightwork_billing_done_failed", detail: String((e as Error).message) }));
    return unavailable;
  }
}
