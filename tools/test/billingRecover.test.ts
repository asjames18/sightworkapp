/** /api/billing/recover logic: re-issued codes go only to the buyer's email; the screen answer never changes. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { brevoSender, handleBillingRecover, mailSender, parseSender, RECOVER_MESSAGE, resendSender } from "@/lib/billing/recover";
import { verifyAccessCode } from "@/lib/billing/accessCode";

const SECRET = "x".repeat(40);
const ENV = { SIGHTWORK_BILLING: "on", STRIPE_SECRET_KEY: "sk_test_abc123", SIGHTWORK_ACCESS_SECRET: SECRET };
const never = async () => {
  throw new Error("must not call Stripe");
};
const quiet = async <T>(fn: () => Promise<T>): Promise<T> => {
  const e = console.error;
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.error = e;
  }
};
const stripe = (customers: unknown[], sessions: unknown[], seen: string[] = []) => async (url: string) => {
  seen.push(url);
  const data = url.includes("/customers?") ? customers : sessions;
  return { ok: true, status: 200, json: async () => ({ data }) };
};
type Mail = { to: string; subject: string; text: string };

test("off, a bad email, or no mail setup never reaches Stripe", async () => {
  const sendMail = async () => {};
  assert.equal((await handleBillingRecover({ email: "a@b.co" }, { env: { ...ENV, SIGHTWORK_BILLING: "" }, fetchImpl: never, sendMail })).status, 404);
  for (const email of [undefined, "", "nope", "a@b", "a b@c.co", "x@y.co,z@y.co"])
    assert.equal((await handleBillingRecover({ email }, { env: ENV, fetchImpl: never, sendMail })).status, 400);
  const r = await quiet(() => handleBillingRecover({ email: "a@b.co" }, { env: ENV, fetchImpl: never, sendMail: null }));
  assert.equal(r.status, 503);
});

test("a buyer gets a pack code and a subscription code by email, and the screen says the same either way", async () => {
  const mails: Mail[] = [];
  const seen: string[] = [];
  const f = stripe(
    [{ id: "cus_Abc123456", email: "Buyer@Example.com" }],
    [
      { mode: "payment", payment_status: "paid", livemode: false, metadata: { sightwork_plan: "pack5" } },
      { mode: "subscription", status: "complete", payment_status: "paid", livemode: false, subscription: "sub_Abc123456", metadata: { sightwork_plan: "church-monthly" } },
      { mode: "payment", payment_status: "unpaid", livemode: false, metadata: { sightwork_plan: "single" } },
      { mode: "payment", payment_status: "paid", livemode: false, metadata: { sightwork_plan: "other-product" } },
    ],
    seen,
  );
  const r = await handleBillingRecover({ email: " Buyer@Example.com " }, { env: ENV, fetchImpl: f, now: () => 5_000_000, sendMail: async (m) => void mails.push(m) });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true, message: RECOVER_MESSAGE });
  assert.match(seen[0], /customers\?email=buyer%40example\.com&limit=3/);
  assert.equal(mails.length, 1);
  assert.equal(mails[0].to, "buyer@example.com");
  const codes = mails[0].text.match(/sw1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g) ?? [];
  assert.equal(codes.length, 2);
  const grants = codes.map((c) => verifyAccessCode(c, { live: false, secret: SECRET }));
  assert.ok(grants.every((g) => g.ok));
  assert.deepEqual(grants.map((g) => (g.ok ? g.grant.stripeId : "")).sort(), ["cus_Abc123456", "sub_Abc123456"]);

  const none = await handleBillingRecover({ email: "nobody@example.com" }, { env: ENV, fetchImpl: stripe([], []), sendMail: async (m) => void mails.push(m) });
  assert.deepEqual(none, r);
  assert.equal(mails.length, 1);
});

test("a customer whose email doesn't match is skipped, and Stripe or mail trouble is one plain line", async () => {
  const mails: Mail[] = [];
  const skipped = await handleBillingRecover(
    { email: "a@b.co" },
    { env: ENV, fetchImpl: stripe([{ id: "cus_Abc123456", email: "other@b.co" }], [{ mode: "payment", payment_status: "paid", livemode: false, metadata: { sightwork_plan: "pack5" } }]), sendMail: async (m) => void mails.push(m) },
  );
  assert.equal(skipped.status, 200);
  assert.equal(mails.length, 0);
  const down = async () => ({ ok: false, status: 500, json: async () => ({}) });
  assert.equal((await quiet(() => handleBillingRecover({ email: "a@b.co" }, { env: ENV, fetchImpl: down, sendMail: async () => {} }))).status, 503);
  const f = stripe([{ id: "cus_Abc123456", email: "a@b.co" }], [{ mode: "payment", payment_status: "paid", livemode: false, metadata: { sightwork_plan: "pack5" } }]);
  const badMail = await quiet(() => handleBillingRecover({ email: "a@b.co" }, { env: ENV, fetchImpl: f, sendMail: async () => { throw new Error("mail down"); } }));
  assert.equal(badMail.status, 503);
});

test("resendSender needs both settings and posts one JSON mail", async () => {
  assert.equal(resendSender({ RESEND_API_KEY: "re_x" }), null);
  const calls: { url: string; body: string }[] = [];
  const s = resendSender({ RESEND_API_KEY: "re_x", SIGHTWORK_MAIL_FROM: "SightWork <hi@example.com>" }, (async (url: string, init: { body: string }) => {
    calls.push({ url, body: init.body });
    return { ok: true, status: 200 };
  }) as unknown as typeof fetch);
  await s!({ to: "a@b.co", subject: "s", text: "t" });
  assert.equal(calls[0].url, "https://api.resend.com/emails");
  assert.deepEqual(JSON.parse(calls[0].body).to, ["a@b.co"]);
});

test("parseSender reads a named or bare sender and refuses anything else", () => {
  assert.deepEqual(parseSender("SightWork <no-reply@example.com>"), { name: "SightWork", email: "no-reply@example.com" });
  assert.deepEqual(parseSender('"Sight Work" <a@b.co>'), { name: "Sight Work", email: "a@b.co" });
  assert.deepEqual(parseSender("<a@b.co>"), { email: "a@b.co" });
  assert.deepEqual(parseSender(" a@b.co "), { email: "a@b.co" });
  for (const bad of ["", "SightWork", "SightWork <nope>", "a@b", "x <a@b.co> y"]) assert.equal(parseSender(bad), null, bad);
});

test("brevoSender needs a key and a valid sender, and posts one transactional mail", async () => {
  assert.equal(brevoSender({ BREVO_API_KEY: "xkeysib-x" }), null);
  assert.equal(brevoSender({ SIGHTWORK_MAIL_FROM: "SightWork <hi@example.com>" }), null);
  assert.equal(brevoSender({ BREVO_API_KEY: "xkeysib-x", SIGHTWORK_MAIL_FROM: "not an address" }), null);
  const calls: { url: string; headers: Record<string, string>; body: string }[] = [];
  const s = brevoSender({ BREVO_API_KEY: " xkeysib-x ", SIGHTWORK_MAIL_FROM: "SightWork <hi@example.com>" }, (async (url: string, init: { headers: Record<string, string>; body: string }) => {
    calls.push({ url, headers: init.headers, body: init.body });
    return { ok: true, status: 201 };
  }) as unknown as typeof fetch);
  await s!({ to: "a@b.co", subject: "s", text: "t" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.brevo.com/v3/smtp/email");
  assert.equal(calls[0].headers["api-key"], "xkeysib-x");
  assert.deepEqual(JSON.parse(calls[0].body), { sender: { name: "SightWork", email: "hi@example.com" }, to: [{ email: "a@b.co" }], subject: "s", textContent: "t" });
});

test("brevoSender throws on a refused send so recovery answers 503", async () => {
  const s = brevoSender({ BREVO_API_KEY: "xkeysib-x", SIGHTWORK_MAIL_FROM: "hi@example.com" }, (async () => ({ ok: false, status: 401 })) as unknown as typeof fetch);
  await assert.rejects(() => s!({ to: "a@b.co", subject: "s", text: "t" }), /401/);
});

test("mailSender prefers Brevo, falls back to Resend, else null", async () => {
  const urls: string[] = [];
  const f = (async (url: string) => {
    urls.push(url);
    return { ok: true, status: 200 };
  }) as unknown as typeof fetch;
  const from = "SightWork <hi@example.com>";
  await mailSender({ BREVO_API_KEY: "k", RESEND_API_KEY: "r", SIGHTWORK_MAIL_FROM: from }, f)!({ to: "a@b.co", subject: "s", text: "t" });
  await mailSender({ RESEND_API_KEY: "r", SIGHTWORK_MAIL_FROM: from }, f)!({ to: "a@b.co", subject: "s", text: "t" });
  assert.deepEqual(urls, ["https://api.brevo.com/v3/smtp/email", "https://api.resend.com/emails"]);
  assert.equal(mailSender({ SIGHTWORK_MAIL_FROM: from }), null);
});
