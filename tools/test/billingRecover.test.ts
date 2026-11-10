/** /api/billing/recover logic: re-issued codes go only to the buyer's email; the screen answer never changes. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { handleBillingRecover, RECOVER_MESSAGE, resendSender } from "@/lib/billing/recover";
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
