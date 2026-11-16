/** POST /api/billing/checkout logic: off by default, plain errors, and no Stripe call without a plan and an email. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { handleCheckout } from "@/lib/billing/checkoutHandler";
import type { FetchLike } from "@/lib/billing/checkout";

const ON = {
  SIGHTWORK_BILLING: "on",
  STRIPE_SECRET_KEY: "sk_test_abc123",
  SIGHTWORK_PRICE_PACK5: "price_pack5test",
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
const never: FetchLike = async () => {
  throw new Error("must not call Stripe");
};

test("billing off answers 404 and never calls Stripe", async () => {
  const r = await handleCheckout(
    { plan: "pack5", email: "buyer@example.com" },
    {
      origin: "https://sightwork.vercel.app",
      env: { ...ON, SIGHTWORK_BILLING: "" },
      fetchImpl: never,
    },
  );
  assert.equal(r.status, 404);
});

test("an unknown or missing plan answers 400 and never calls Stripe", async () => {
  for (const body of [{ plan: "gold", email: "buyer@example.com" }, {}, null, "pack5", { plan: 5 }]) {
    const r = await handleCheckout(body, {
      origin: "https://sightwork.vercel.app",
      env: ON,
      fetchImpl: never,
    });
    assert.equal(r.status, 400);
  }
});

test("a good plan returns Stripe's hosted Checkout address", async () => {
  const fetchImpl: FetchLike = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      id: "cs_test_1",
      url: "https://checkout.stripe.com/c/pay/cs_test_1",
    }),
  });
  const r = await handleCheckout(
    { plan: "pack5", email: "buyer@example.com" },
    { origin: "https://sightwork.vercel.app", env: ON, fetchImpl },
  );
  assert.deepEqual(r, {
    status: 200,
    body: { url: "https://checkout.stripe.com/c/pay/cs_test_1" },
  });
});

test("Stripe failures and a missing key come back as one plain 503 line with no Stripe text", async () => {
  const fetchImpl: FetchLike = async () => ({
    ok: false,
    status: 400,
    json: async () => ({ error: { message: "No such price: secret detail" } }),
  });
  for (const [env, f] of [
    [ON, fetchImpl],
    [{ ...ON, STRIPE_SECRET_KEY: "" }, never],
    [{ ...ON, SIGHTWORK_PRICE_PACK5: "" }, never],
  ] as const) {
    const r = await quiet(() =>
      handleCheckout(
        { plan: "pack5", email: "buyer@example.com" },
        { origin: "https://sightwork.vercel.app", env, fetchImpl: f },
      ),
    );
    assert.equal(r.status, 503);
    assert.doesNotMatch(JSON.stringify(r.body), /secret|price|sk_/i);
  }
});

test("a missing or invalid email answers 400 and never calls Stripe", async () => {
  for (const body of [
    { plan: "pack5" },
    { plan: "pack5", email: "" },
    { plan: "pack5", email: "not-an-email" },
    { plan: "pack5", email: "a@b" },
    { plan: "pack5", email: 42 },
    { plan: "church-monthly", email: "  " },
  ]) {
    const r = await handleCheckout(body, {
      origin: "https://sightwork.vercel.app",
      env: ON,
      fetchImpl: never,
    });
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.deepEqual(r.body, {
      error: "Enter a valid email address so we can send your access code.",
    });
  }
});

test("the email reaches Stripe as customer_email and never appears in the failure log", async () => {
  let sent = "";
  const ok: FetchLike = async (_url, init) => {
    sent = init.body;
    return {
      ok: true,
      status: 200,
      json: async () => ({ id: "cs_test_2", url: "https://checkout.stripe.com/c/pay/cs_test_2" }),
    };
  };
  const r = await handleCheckout(
    { plan: "pack5", email: " Buyer@Example.com " },
    { origin: "https://sightwork.vercel.app", env: ON, fetchImpl: ok },
  );
  assert.equal(r.status, 200);
  const form = new URLSearchParams(sent);
  assert.equal(form.get("customer_email"), "buyer@example.com");
  assert.equal(form.get("customer_creation"), "always");

  const logged: string[] = [];
  const e = console.error;
  console.error = (...a: unknown[]) => void logged.push(a.map(String).join(" "));
  try {
    const bad: FetchLike = async () => ({ ok: false, status: 500, json: async () => ({}) });
    const r2 = await handleCheckout(
      { plan: "pack5", email: "private.person@example.com" },
      { origin: "https://sightwork.vercel.app", env: ON, fetchImpl: bad },
    );
    assert.equal(r2.status, 503);
  } finally {
    console.error = e;
  }
  assert.equal(logged.length, 1);
  assert.doesNotMatch(logged.join("\n"), /private\.person|example\.com/);
});
