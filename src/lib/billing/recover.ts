// "Find my purchase": a buyer types the email they paid with and gets their access code re-issued
// by email. Stripe is the record, so nothing is stored here. The answer on screen is the same
// whether or not anything was found, so the form can't be used to learn who has bought.
import { accessSecret, billingEnabled, issueAccessCode, type AccessGrant } from "./accessCode";
import { STRIPE_API } from "./checkout";
import { findPlan } from "./plans";

export interface RecoverReply {
  status: number;
  body: { ok: true; message: string } | { error: string };
}

type GetLike = (url: string, init: { method: string; headers: Record<string, string> }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;
export type MailSender = (mail: { to: string; subject: string; text: string }) => Promise<void>;

export const RECOVER_MESSAGE = "If that email was used to buy a plan, we've sent your access code to it. It can take a few minutes.";
const EMAIL = /^[^\s@<>"',;]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;
const MAX_CODES = 5;

const idOf = (v: unknown): string | null =>
  typeof v === "string" ? v : v && typeof v === "object" && typeof (v as { id?: unknown }).id === "string" ? (v as { id: string }).id : null;

/** Sends through Resend when RESEND_API_KEY and SIGHTWORK_MAIL_FROM are set; otherwise null. */
export function resendSender(env: Record<string, string | undefined>, fetchImpl: typeof fetch = fetch): MailSender | null {
  const key = env.RESEND_API_KEY?.trim();
  const from = env.SIGHTWORK_MAIL_FROM?.trim();
  if (!key || !from) return null;
  return async (m) => {
    const res = await fetchImpl("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [m.to], subject: m.subject, text: m.text }),
    });
    if (!res.ok) throw new Error(`mail service answered ${res.status}`);
  };
}

export async function handleBillingRecover(
  rawBody: unknown,
  ctx: { env?: Record<string, string | undefined>; fetchImpl?: GetLike; sendMail?: MailSender | null; now?: () => number },
): Promise<RecoverReply> {
  const env = ctx.env ?? process.env;
  if (!billingEnabled(env.SIGHTWORK_BILLING)) return { status: 404, body: { error: "Not found." } };
  const raw = (rawBody as { email?: unknown } | null)?.email;
  const email = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (!EMAIL.test(email)) return { status: 400, body: { error: "Enter the email you used to pay." } };
  const key = env.STRIPE_SECRET_KEY?.trim();
  const secret = accessSecret(env.SIGHTWORK_ACCESS_SECRET);
  const send = ctx.sendMail === undefined ? resendSender(env) : ctx.sendMail;
  if (!key || !/^(sk|rk)_(test|live)_[A-Za-z0-9]+$/.test(key) || !secret || !send) {
    console.error(JSON.stringify({ event: "sightwork_billing_recover_failed", detail: "not configured" }));
    return { status: 503, body: { error: "We can't look that up right now. Please try again in a few minutes." } };
  }
  try {
    const f = ctx.fetchImpl ?? (fetch as unknown as GetLike);
    const get = async (path: string) => {
      const res = await f(`${STRIPE_API}${path}`, { method: "GET", headers: { Authorization: `Bearer ${key}` } });
      if (!res.ok) throw new Error(`Stripe answered ${res.status}`);
      return (await res.json()) as { data?: unknown };
    };
    const customers = ((await get(`/customers?${new URLSearchParams({ email, limit: "3" })}`)).data ?? []) as { id?: unknown; email?: unknown }[];
    const issuedAt = Math.floor((ctx.now ?? Date.now)() / 1000);
    const lines: string[] = [];
    const seen = new Set<string>();
    for (const c of customers) {
      const cid = idOf(c);
      if (!cid || !/^cus_[A-Za-z0-9]{6,64}$/.test(cid) || (typeof c.email === "string" && c.email.toLowerCase() !== email)) continue;
      const sessions = ((await get(`/checkout/sessions?${new URLSearchParams({ customer: cid, limit: "20" })}`)).data ?? []) as Record<string, unknown>[];
      for (const s of sessions) {
        const plan = findPlan(((s.metadata ?? {}) as { sightwork_plan?: unknown }).sightwork_plan);
        if (!plan || typeof s.livemode !== "boolean" || plan.mode !== s.mode) continue;
        let grant: AccessGrant | null = null;
        if (s.mode === "payment" && s.payment_status === "paid") grant = { kind: "pack", stripeId: cid, live: s.livemode, issuedAt };
        else if (s.mode === "subscription" && s.status === "complete" && (s.payment_status === "paid" || s.payment_status === "no_payment_required")) {
          const sub = idOf(s.subscription);
          if (sub) grant = { kind: "sub", stripeId: sub, live: s.livemode, issuedAt };
        }
        if (!grant || seen.has(grant.stripeId) || seen.size >= MAX_CODES) continue;
        seen.add(grant.stripeId);
        lines.push(`${plan.name}\n${issueAccessCode(grant, secret)}`);
      }
    }
    if (lines.length > 0) {
      await send({
        to: email,
        subject: "Your SightWork access code",
        text: `Here ${lines.length === 1 ? "is your access code" : "are your access codes"}. Paste one into SightWork to use your plan.\n\n${lines.join("\n\n")}\n\nIf you didn't ask for this, you can ignore this email.`,
      });
    }
    return { status: 200, body: { ok: true, message: RECOVER_MESSAGE } };
  } catch (e) {
    console.error(JSON.stringify({ event: "sightwork_billing_recover_failed", detail: String((e as Error).message) }));
    return { status: 503, body: { error: "We can't look that up right now. Please try again in a few minutes." } };
  }
}
