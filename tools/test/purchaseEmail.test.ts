/** The access-code email after a purchase: built from Stripe's signed checkout event, sent once per delivery, never throws. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { purchaseMailFor, sendPurchaseEmail } from "@/lib/billing/purchaseEmail";
import { verifyAccessCode } from "@/lib/billing/accessCode";

const SECRET = "x".repeat(40);
const ENV = { SIGHTWORK_BILLING: "on", SIGHTWORK_ACCESS_SECRET: SECRET };
const NOW = 1_800_000_000;
type Mail = { to: string; subject: string; text: string };

const paidSingle = (over: Record<string, unknown> = {}) => ({
  id: "evt_1",
  type: "checkout.session.completed",
  livemode: false,
  data: {
    object: {
      id: "cs_test_abc123",
      mode: "payment",
      payment_status: "paid",
      status: "complete",
      livemode: false,
      customer: "cus_Abc123456",
      customer_details: { email: "Buyer@Example.com" },
      metadata: { sightwork_plan: "single" },
      ...over,
    },
  },
});

const quiet = async <T>(fn: () => Promise<T>): Promise<T> => {
  const l = console.log, e = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.log = l;
    console.error = e;
  }
};

test("a paid plan checkout becomes an email to the address typed at checkout, with a working code", () => {
  const r = purchaseMailFor(paidSingle(), SECRET, NOW);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.mail.to, "Buyer@Example.com");
  assert.equal(r.mail.subject, "Your SightWork access code");
  assert.match(r.mail.text, /Single Plan/);
  const code = r.mail.text.match(/sw1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/)?.[0] ?? "";
  const v = verifyAccessCode(code, { live: false, secret: SECRET });
  assert.ok(v.ok);
  if (v.ok) assert.equal(v.grant.stripeId, "cus_Abc123456");
});

test("a subscription checkout gets a code for the subscription", () => {
  const r = purchaseMailFor(
    paidSingle({ mode: "subscription", subscription: "sub_Abc123456", metadata: { sightwork_plan: "church-monthly" } }),
    SECRET,
    NOW,
  );
  assert.ok(r.ok);
  if (!r.ok) return;
  const code = r.mail.text.match(/sw1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/)?.[0] ?? "";
  const v = verifyAccessCode(code, { live: false, secret: SECRET });
  assert.ok(v.ok && v.grant.stripeId === "sub_Abc123456");
});

test("unpaid, foreign, mismatched or address-less checkouts send nothing, and say why", () => {
  const cases: [unknown, string][] = [
    [{ ...paidSingle(), type: "invoice.paid" }, "not a checkout"],
    [paidSingle({ payment_status: "unpaid" }), "not paid"],
    [paidSingle({ customer: null }), "not paid"],
    [paidSingle({ metadata: { sightwork_plan: "other" } }), "not a SightWork plan"],
    [paidSingle({ mode: "subscription" }), "not a SightWork plan"],
    [paidSingle({ customer_details: { email: "not-an-email" } }), "no email"],
    [paidSingle({ customer_details: null }), "no email"],
  ];
  for (const [ev, reason] of cases) assert.deepEqual(purchaseMailFor(ev, SECRET, NOW), { ok: false, reason }, reason);
  assert.deepEqual(purchaseMailFor(paidSingle(), null, NOW), { ok: false, reason: "not configured" });
});

test("sending: one mail per paid delivery; no sender or a failing sender never throws", async () => {
  const mails: Mail[] = [];
  const raw = JSON.stringify(paidSingle());
  assert.deepEqual(await quiet(() => sendPurchaseEmail(raw, { env: ENV, sendMail: async (m) => void mails.push(m), now: () => NOW * 1000 })), { sent: true });
  assert.equal(mails.length, 1);
  assert.deepEqual(await quiet(() => sendPurchaseEmail(raw, { env: ENV, sendMail: null })), { sent: false, reason: "not configured" });
  assert.deepEqual(
    await quiet(() => sendPurchaseEmail(raw, { env: ENV, sendMail: async () => { throw new Error("mail service answered 401 (unauthorized)"); } })),
    { sent: false, reason: "send failed" },
  );
  assert.deepEqual(await quiet(() => sendPurchaseEmail("{not json", { env: ENV, sendMail: async (m) => void mails.push(m) })), { sent: false, reason: "not a checkout" });
  assert.equal(mails.length, 1);
});

test("the log lines carry no address and no code", async () => {
  const lines: string[] = [];
  const l = console.log, e = console.error;
  console.log = (s: string) => void lines.push(String(s));
  console.error = (s: string) => void lines.push(String(s));
  try {
    await sendPurchaseEmail(JSON.stringify(paidSingle()), { env: ENV, sendMail: async () => {} });
    await sendPurchaseEmail(JSON.stringify(paidSingle()), { env: ENV, sendMail: async () => { throw new Error("mail service answered 400"); } });
  } finally {
    console.log = l;
    console.error = e;
  }
  assert.equal(lines.length, 2);
  for (const s of lines) {
    assert.doesNotMatch(s, /@/);
    assert.doesNotMatch(s, /sw1\./);
  }
});
