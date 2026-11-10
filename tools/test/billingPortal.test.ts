/** /api/billing/portal logic: only an active subscription code reaches Stripe's billing portal. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { handleBillingPortal } from "@/lib/billing/portal";
import { issueAccessCode } from "@/lib/billing/accessCode";

const SECRET = "x".repeat(40);
const ENV = { SIGHTWORK_BILLING: "on", STRIPE_SECRET_KEY: "sk_test_abc123", SIGHTWORK_ACCESS_SECRET: SECRET };
const ORIGIN = "https://sightwork.example.com";
const subCode = issueAccessCode({ kind: "sub", stripeId: "sub_Abc123456", live: false, issuedAt: 1 }, SECRET);
const packCode = issueAccessCode({ kind: "pack", stripeId: "cus_Abc123456", live: false, issuedAt: 1 }, SECRET);
const liveCode = issueAccessCode({ kind: "sub", stripeId: "sub_Abc123456", live: true, issuedAt: 1 }, SECRET);
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
const stripe = (subStatus: number, sub: unknown, portal: unknown, seen: string[] = []) =>
  async (url: string, init: { method: string; body?: string }) => {
    // Fetch refuses a GET that has a body, so a GET must not carry one.
    if (init.method === "GET" && init.body !== undefined) throw new TypeError("Request with GET/HEAD method cannot have body.");
    seen.push(`${init.method} ${url} ${init.body ?? ""}`);
    if (url.includes("/subscriptions/")) return { ok: subStatus < 300, status: subStatus, json: async () => sub };
    return { ok: true, status: 200, json: async () => portal };
  };

test("off, a bad code, a live code on a test key, or a pack code never reach Stripe", async () => {
  assert.equal((await handleBillingPortal({ code: subCode }, { origin: ORIGIN, env: { ...ENV, SIGHTWORK_BILLING: "" }, fetchImpl: never })).status, 404);
  for (const code of [undefined, "", "sw1.a.b", subCode + "x", liveCode])
    assert.equal((await handleBillingPortal({ code }, { origin: ORIGIN, env: ENV, fetchImpl: never })).status, 400);
  assert.equal((await handleBillingPortal({ code: packCode }, { origin: ORIGIN, env: ENV, fetchImpl: never })).status, 400);
  assert.equal((await handleBillingPortal(null, { origin: ORIGIN, env: ENV, fetchImpl: never })).status, 400);
});

test("an active subscription gets a portal link that returns to /pricing", async () => {
  const seen: string[] = [];
  const r = await handleBillingPortal(
    { code: subCode },
    { origin: ORIGIN, env: ENV, fetchImpl: stripe(200, { customer: "cus_Abc123456", status: "active" }, { url: "https://billing.stripe.com/p/session/abc" }, seen) },
  );
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { url: "https://billing.stripe.com/p/session/abc" });
  assert.equal(seen.length, 2);
  assert.match(seen[1], /billing_portal\/sessions customer=cus_Abc123456&return_url=https%3A%2F%2Fsightwork\.example\.com%2Fpricing/);
});

test("a canceled or missing subscription is refused, and Stripe trouble gives one plain line", async () => {
  const canceled = await handleBillingPortal({ code: subCode }, { origin: ORIGIN, env: ENV, fetchImpl: stripe(200, { customer: "cus_Abc123456", status: "canceled" }, {}) });
  assert.equal(canceled.status, 409);
  const missing = await handleBillingPortal({ code: subCode }, { origin: ORIGIN, env: ENV, fetchImpl: stripe(404, {}, {}) });
  assert.equal(missing.status, 404);
  const odd = await quiet(() => handleBillingPortal({ code: subCode }, { origin: ORIGIN, env: ENV, fetchImpl: stripe(200, { customer: "cus_Abc123456", status: "active" }, { url: "https://evil.example.com/x" }) }));
  assert.equal(odd.status, 503);
  const noKey = await quiet(() => handleBillingPortal({ code: subCode }, { origin: ORIGIN, env: { SIGHTWORK_BILLING: "on" }, fetchImpl: never }));
  assert.equal(noKey.status, 503);
  const badOrigin = await quiet(() => handleBillingPortal({ code: subCode }, { origin: "http://evil.example.com", env: ENV, fetchImpl: never }));
  assert.equal(badOrigin.status, 503);
});
