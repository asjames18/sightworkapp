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

export const RECOVER_MESSAGE =
  "If that email was used to buy a plan, we've sent your access code to it. It can take a few minutes. " +
  "Look for \"Your SightWork access code\" from no-reply@melanatedintech.com, and check your Updates, Promotions or spam folder if it isn't in your inbox.";
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

/** "SightWork <no-reply@example.com>" or a bare address, as Brevo's {name, email} sender. Null when it isn't an address. */
export function parseSender(from: string): { name?: string; email: string } | null {
  const m = /^\s*(?:"?([^"<>]{1,100}?)"?\s*)?<([^\s<>@]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24})>\s*$/.exec(from);
  if (m) return m[1]?.trim() ? { name: m[1].trim(), email: m[2] } : { email: m[2] };
  const bare = from.trim();
  return EMAIL.test(bare) ? { email: bare } : null;
}

/** The plain-text mail as simple HTML: escaped, line breaks kept, access codes easy to select. */
export function mailHtml(text: string): string {
  const esc = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const body = esc
    .split(/\n{2,}/)
    .map((para) => {
      const p = para.replace(/(sw1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/g, '<code style="font-size:15px;word-break:break-all;background:#f3f3f3;padding:2px 4px">$1</code>');
      return `<p style="margin:0 0 16px">${p.replace(/\n/g, "<br>")}</p>`;
    })
    .join("");
  return `<!doctype html><html><body style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#111">${body}</body></html>`;
}

/** Brevo answers that are worth one more try: rate limits and its own server errors. */
const RETRYABLE = (status: number) => status === 429 || status >= 500;

/** Sends through Brevo's transactional API when BREVO_API_KEY and SIGHTWORK_MAIL_FROM are set; otherwise null. */
export function brevoSender(
  env: Record<string, string | undefined>,
  fetchImpl: typeof fetch = fetch,
  retryDelayMs = 800,
): MailSender | null {
  const key = env.BREVO_API_KEY?.trim();
  const sender = parseSender(env.SIGHTWORK_MAIL_FROM?.trim() ?? "");
  if (!key || !sender) return null;
  return async (m) => {
    const init = {
      method: "POST",
      headers: { "api-key": key, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ sender, to: [{ email: m.to }], subject: m.subject, textContent: m.text, htmlContent: mailHtml(m.text) }),
    };
    // One retry on a dropped connection, a rate limit or a Brevo server error, so a brief hiccup doesn't lose
    // a buyer's code. A refusal (bad key, bad sender) isn't retried: it won't change in a second.
    let res: Response;
    try {
      res = await fetchImpl("https://api.brevo.com/v3/smtp/email", init);
    } catch {
      await new Promise((r) => setTimeout(r, retryDelayMs));
      res = await fetchImpl("https://api.brevo.com/v3/smtp/email", init);
    }
    if (!res.ok && RETRYABLE(res.status)) {
      await new Promise((r) => setTimeout(r, retryDelayMs));
      res = await fetchImpl("https://api.brevo.com/v3/smtp/email", init);
    }
    // Brevo's error body names the cause ("unauthorized", "invalid_parameter"...): keep its short code for the
    // log, never the message text, which can echo the address.
    if (!res.ok) throw new Error(`mail service answered ${res.status}${await brevoErrorCode(res)}`);
  };
}

async function brevoErrorCode(res: Response): Promise<string> {
  try {
    const v = (await res.json()) as { code?: unknown };
    return typeof v?.code === "string" && /^[a-z_]{1,40}$/.test(v.code) ? ` (${v.code})` : "";
  } catch {
    return "";
  }
}

/** The mail sender for this server: Brevo when it's set up, else Resend, else null (recovery answers 503). */
export function mailSender(env: Record<string, string | undefined>, fetchImpl: typeof fetch = fetch): MailSender | null {
  return brevoSender(env, fetchImpl) ?? resendSender(env, fetchImpl);
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
  const send = ctx.sendMail === undefined ? mailSender(env) : ctx.sendMail;
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
    // Stripe's email filter is case-sensitive and Checkout keeps the address as typed, so look up the
    // lower-case form and, when it differs, the form typed here too.
    type Cus = { id?: unknown; email?: unknown };
    const typed = typeof raw === "string" ? raw.trim() : "";
    const forms = typed && typed !== email ? [email, typed] : [email];
    const customers: Cus[] = [];
    for (const form of forms) {
      for (const c of ((await get(`/customers?${new URLSearchParams({ email: form, limit: "3" })}`)).data ?? []) as Cus[]) {
        if (!customers.some((k) => idOf(k) === idOf(c))) customers.push(c);
      }
    }
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
    // One line per lookup, with counts only (no address, no code), so a "no email came" report can be traced.
    console.log(JSON.stringify({ event: "sightwork_billing_recover", customers: customers.length, codes: lines.length, sending: lines.length > 0 }));
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
