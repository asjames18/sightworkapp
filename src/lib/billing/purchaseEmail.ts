// The access-code email sent right after a purchase. Server only.
// The return page (/billing/done) shows the code too, but a buyer who closes that tab, pays on another
// device, or loses the browser's storage needs it in their inbox. Stripe's signed checkout.session.completed
// event carries everything needed: the plan, the customer or subscription, and the email typed at checkout.
// Nothing is stored here; a repeat delivery of the same event sends the same code again, which is harmless.
import { accessSecret, issueAccessCode, type AccessGrant } from "./accessCode";
import { findPlan } from "./plans";
import { mailSender, type MailSender } from "./recover";

const EMAIL = /^[^\s@<>"',;]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;

const idOf = (v: unknown): string | null =>
  typeof v === "string" ? v : v && typeof v === "object" && typeof (v as { id?: unknown }).id === "string" ? (v as { id: string }).id : null;

export type PurchaseMail = { to: string; subject: string; text: string };

/** Why no email went out, for the log line. Never carries the address or the code. */
export type NoMailReason = "not a checkout" | "not a SightWork plan" | "not paid" | "no email" | "not configured";

/** Builds the email for a paid SightWork checkout, or says why there is none. Pure apart from signing. */
export function purchaseMailFor(
  event: unknown,
  secret: string | null,
  nowSeconds: number,
): { ok: true; mail: PurchaseMail; plan: string } | { ok: false; reason: NoMailReason } {
  const ev = event as { type?: unknown; data?: { object?: Record<string, unknown> } } | null;
  if (ev?.type !== "checkout.session.completed") return { ok: false, reason: "not a checkout" };
  const s = ev.data?.object ?? {};
  const plan = findPlan(((s.metadata ?? {}) as { sightwork_plan?: unknown }).sightwork_plan);
  if (!plan || typeof s.livemode !== "boolean" || plan.mode !== s.mode) return { ok: false, reason: "not a SightWork plan" };
  let grant: AccessGrant | null = null;
  if (s.mode === "payment" && s.payment_status === "paid") {
    const cus = idOf(s.customer);
    if (cus) grant = { kind: "pack", stripeId: cus, live: s.livemode, issuedAt: nowSeconds };
  } else if (s.mode === "subscription" && s.status === "complete" && (s.payment_status === "paid" || s.payment_status === "no_payment_required")) {
    const sub = idOf(s.subscription);
    if (sub) grant = { kind: "sub", stripeId: sub, live: s.livemode, issuedAt: nowSeconds };
  }
  if (!grant) return { ok: false, reason: "not paid" };
  const details = (s.customer_details ?? {}) as { email?: unknown };
  const raw = typeof details.email === "string" ? details.email : typeof s.customer_email === "string" ? s.customer_email : "";
  const to = raw.trim();
  if (!EMAIL.test(to)) return { ok: false, reason: "no email" };
  if (!secret) return { ok: false, reason: "not configured" };
  const code = issueAccessCode(grant, secret);
  return {
    ok: true,
    plan: plan.name,
    mail: {
      to,
      subject: "Your SightWork access code",
      text:
        `Thanks for buying the SightWork ${plan.name}.\n\n` +
        `Your access code:\n${code}\n\n` +
        `If you came back to SightWork after paying, it's already saved in that browser. On another phone or computer, open SightWork and paste it into the Access code field.\n\n` +
        `Lost this email? Use "Find my purchase" on the pricing page with this email address and we'll send the code again.`,
    },
  };
}

/**
 * Sends the access-code email for a verified checkout.session.completed event. Never throws: a mail problem
 * is logged (with no address or code) and the webhook still answers 200, since the purchase itself is fine
 * and the buyer can get the code again from "Find my purchase".
 */
export async function sendPurchaseEmail(
  rawEvent: string,
  ctx: { env?: Record<string, string | undefined>; sendMail?: MailSender | null; now?: () => number } = {},
): Promise<{ sent: boolean; reason?: NoMailReason | "send failed" }> {
  const env = ctx.env ?? process.env;
  let event: unknown;
  try {
    event = JSON.parse(rawEvent);
  } catch {
    return { sent: false, reason: "not a checkout" };
  }
  const id = (event as { id?: unknown } | null)?.id;
  const built = purchaseMailFor(event, accessSecret(env.SIGHTWORK_ACCESS_SECRET), Math.floor((ctx.now ?? Date.now)() / 1000));
  if (!built.ok) {
    if (built.reason !== "not a checkout") console.log(JSON.stringify({ event: "sightwork_purchase_email", id, sent: false, reason: built.reason }));
    return { sent: false, reason: built.reason };
  }
  const send = ctx.sendMail === undefined ? mailSender(env) : ctx.sendMail;
  if (!send) {
    console.error(JSON.stringify({ event: "sightwork_purchase_email_failed", id, detail: "mail not configured" }));
    return { sent: false, reason: "not configured" };
  }
  try {
    await send(built.mail);
    console.log(JSON.stringify({ event: "sightwork_purchase_email", id, sent: true, plan: built.plan }));
    return { sent: true };
  } catch (e) {
    console.error(JSON.stringify({ event: "sightwork_purchase_email_failed", id, detail: String((e as Error).message) }));
    return { sent: false, reason: "send failed" };
  }
}
