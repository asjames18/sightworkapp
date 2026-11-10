// Stripe webhook receiver. Server only. Stripe is the system of record and nothing is stored here,
// so every event is handled as a pure, repeatable check: the same event delivered twice gives the
// same answer and changes nothing. The signature is checked over the raw body before anything is read.
import { createHmac, timingSafeEqual } from "node:crypto";
import { billingEnabled } from "./accessCode";

/** Stripe's own default: reject signatures older (or newer) than five minutes. */
export const WEBHOOK_TOLERANCE_SECONDS = 300;

const HANDLED = new Set([
  "checkout.session.completed",
  "invoice.paid",
  "invoice.payment_failed",
  "customer.subscription.updated",
  "customer.subscription.deleted",
]);

export interface WebhookReply {
  status: number;
  body: { received: true; handled: boolean; id?: string; type?: string } | { error: string };
}

/** Checks a Stripe-Signature header (t=...,v1=...) against the raw body. */
export function verifyStripeSignature(raw: string, header: string | null, secret: string, nowSeconds: number): boolean {
  if (!header || header.length > 2000) return false;
  let t = "";
  const sigs: string[] = [];
  for (const part of header.split(",")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k === "t") t = v;
    else if (k === "v1") sigs.push(v);
  }
  if (!/^\d{1,12}$/.test(t) || sigs.length === 0) return false;
  if (Math.abs(nowSeconds - Number(t)) > WEBHOOK_TOLERANCE_SECONDS) return false;
  const expected = createHmac("sha256", secret).update(`${t}.${raw}`).digest();
  return sigs.some((s) => {
    if (!/^[0-9a-f]{64}$/i.test(s)) return false;
    return timingSafeEqual(expected, Buffer.from(s, "hex"));
  });
}

/** Handles one delivery. Unknown event types are acknowledged so Stripe stops retrying them. */
export function handleBillingWebhook(
  raw: string,
  signature: string | null,
  ctx: { env?: Record<string, string | undefined>; now?: () => number } = {},
): WebhookReply {
  const env = ctx.env ?? process.env;
  if (!billingEnabled(env.SIGHTWORK_BILLING)) return { status: 404, body: { error: "Not found." } };
  const secret = env.STRIPE_WEBHOOK_SECRET?.trim();
  if (!secret || !/^whsec_[A-Za-z0-9+/=_-]{8,}$/.test(secret)) {
    console.error(JSON.stringify({ event: "sightwork_billing_webhook_failed", detail: "not configured" }));
    return { status: 503, body: { error: "Webhook is not configured." } };
  }
  const now = Math.floor((ctx.now ?? Date.now)() / 1000);
  if (raw.length > 1_000_000 || !verifyStripeSignature(raw, signature, secret, now)) {
    return { status: 400, body: { error: "Bad signature." } };
  }
  let ev: { id?: unknown; type?: unknown; livemode?: unknown };
  try {
    ev = JSON.parse(raw);
  } catch {
    return { status: 400, body: { error: "Bad payload." } };
  }
  if (typeof ev.id !== "string" || typeof ev.type !== "string") {
    return { status: 400, body: { error: "Bad payload." } };
  }
  const handled = HANDLED.has(ev.type);
  // Access codes are checked against Stripe on use, so these events only need a log line for now.
  console.log(JSON.stringify({ event: "sightwork_billing_webhook", id: ev.id, type: ev.type, handled, live: ev.livemode === true }));
  return { status: 200, body: { received: true, handled, id: ev.id, type: ev.type } };
}
