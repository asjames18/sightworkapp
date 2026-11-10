import { test } from "node:test";
import assert from "node:assert/strict";
import { PAID_PLANS, findPlan, planPriceId } from "../../src/lib/billing/plans";
import { buildCheckoutParams, createCheckoutSession, type FetchLike } from "../../src/lib/billing/checkout";

const ENV: Record<string, string> = Object.fromEntries(
  PAID_PLANS.map((p, i) => [p.priceEnv, `price_Test${String(i).padStart(4, "0")}abc`]),
);
const ORIGIN = "https://sightwork.vercel.app";
const KEY = "sk_test_abc123DEF456";

test("the catalog matches the agreed prices and has unique keys and env names", () => {
  assert.deepEqual(PAID_PLANS.map((p) => [p.key, p.usd]), [
    ["single", 9], ["pack5", 29], ["church-monthly", 19], ["church-yearly", 190],
    ["ministry-monthly", 49], ["ministry-yearly", 490], ["multisite-monthly", 129], ["multisite-yearly", 1290],
  ]);
  assert.equal(new Set(PAID_PLANS.map((p) => p.priceEnv)).size, PAID_PLANS.length);
  for (const p of PAID_PLANS) {
    assert.equal(p.mode === "payment", typeof p.credits === "number");
    assert.equal(p.yearly, p.key.endsWith("-yearly"));
  }
});

test("findPlan and planPriceId only accept real values", () => {
  assert.equal(findPlan("pack5")?.credits, 5);
  assert.equal(findPlan("nope"), null);
  assert.equal(findPlan(5), null);
  const single = findPlan("single")!;
  assert.equal(planPriceId(single, {}), null);
  assert.equal(planPriceId(single, { SIGHTWORK_PRICE_SINGLE: "prod_123456" }), null);
  assert.equal(planPriceId(single, { SIGHTWORK_PRICE_SINGLE: " price_abc123 " }), "price_abc123");
});

test("a pack checks out as a one-time payment that makes a customer, with no discount codes", () => {
  const p = new Map(buildCheckoutParams({ plan: findPlan("pack5")!, origin: ORIGIN, env: ENV }));
  assert.equal(p.get("mode"), "payment");
  assert.equal(p.get("customer_creation"), "always");
  assert.equal(p.get("line_items[0][price]"), ENV.SIGHTWORK_PRICE_PACK5);
  assert.equal(p.get("success_url"), `${ORIGIN}/billing/done?session_id={CHECKOUT_SESSION_ID}`);
  assert.equal(p.get("metadata[sightwork_plan]"), "pack5");
  assert.equal(p.has("allow_promotion_codes"), false);
});

test("monthly plans take no codes and yearly plans allow the nonprofit code", () => {
  const m = new Map(buildCheckoutParams({ plan: findPlan("church-monthly")!, origin: ORIGIN, env: ENV }));
  assert.equal(m.get("mode"), "subscription");
  assert.equal(m.has("customer_creation"), false);
  assert.equal(m.has("allow_promotion_codes"), false);
  assert.equal(m.get("subscription_data[metadata][sightwork_plan]"), "church-monthly");
  const y = new Map(buildCheckoutParams({ plan: findPlan("ministry-yearly")!, origin: ORIGIN, env: ENV }));
  assert.equal(y.get("allow_promotion_codes"), "true");
});

test("a missing price or a foreign origin is refused", () => {
  assert.throws(() => buildCheckoutParams({ plan: findPlan("single")!, origin: ORIGIN, env: {} }), /no Stripe price/);
  for (const o of ["http://sightwork.vercel.app", "https://evil.example/x", "javascript:alert(1)"]) {
    assert.throws(() => buildCheckoutParams({ plan: findPlan("single")!, origin: o, env: ENV }), /origin/, o);
  }
  assert.doesNotThrow(() => buildCheckoutParams({ plan: findPlan("single")!, origin: "http://localhost:3000", env: ENV }));
});

test("creating a session posts a form with the key only in the header", async () => {
  let seen: { url: string; init: Parameters<FetchLike>[1] } | null = null;
  const fetchImpl: FetchLike = async (url, init) => {
    seen = { url, init };
    return { ok: true, status: 200, json: async () => ({ id: "cs_test_1", url: "https://checkout.stripe.com/c/pay/cs_test_1" }) };
  };
  const r = await createCheckoutSession({ plan: findPlan("single")!, origin: ORIGIN, env: ENV, secretKey: KEY, fetchImpl });
  assert.deepEqual(r, { id: "cs_test_1", url: "https://checkout.stripe.com/c/pay/cs_test_1" });
  assert.equal(seen!.url, "https://api.stripe.com/v1/checkout/sessions");
  assert.equal(seen!.init.headers.Authorization, `Bearer ${KEY}`);
  assert.equal(seen!.init.body.includes(KEY), false);
  assert.match(seen!.init.body, /mode=payment/);
});

test("no key, a Stripe error or an odd answer fails with a plain message", async () => {
  const plan = findPlan("single")!;
  await assert.rejects(createCheckoutSession({ plan, origin: ORIGIN, env: ENV, secretKey: undefined }), /key is not set/);
  await assert.rejects(createCheckoutSession({ plan, origin: ORIGIN, env: ENV, secretKey: "pk_test_abc" }), /key is not set/);
  const err: FetchLike = async () => ({ ok: false, status: 400, json: async () => ({ error: { message: "secret detail" } }) });
  await assert.rejects(createCheckoutSession({ plan, origin: ORIGIN, env: ENV, secretKey: KEY, fetchImpl: err }), (e: Error) =>
    e.message === "checkout: Stripe answered 400",
  );
  const odd: FetchLike = async () => ({ ok: true, status: 200, json: async () => ({ id: "cs_1", url: "https://evil.example" }) });
  await assert.rejects(createCheckoutSession({ plan, origin: ORIGIN, env: ENV, secretKey: KEY, fetchImpl: odd }), /unexpected/);
});
