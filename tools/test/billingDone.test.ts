/** /billing/done logic: only a paid, SightWork-made Stripe session earns a code. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { handleBillingDone } from "@/lib/billing/session";
import { verifyAccessCode } from "@/lib/billing/accessCode";

const SECRET = "x".repeat(40);
const ENV = { SIGHTWORK_BILLING: "on", STRIPE_SECRET_KEY: "sk_test_abc123", SIGHTWORK_ACCESS_SECRET: SECRET };
const SID = "cs_test_a1B2c3D4e5";
const quiet = async <T>(fn: () => Promise<T>): Promise<T> => {
  const e = console.error;
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.error = e;
  }
};
const stripe = (status: number, json: unknown, seen?: string[]) => async (url: string, init: { method: string }) => {
  seen?.push(`${init.method} ${url}`);
  return { ok: status >= 200 && status < 300, status, json: async () => json };
};
const never = async () => {
  throw new Error("must not call Stripe");
};

test("off, or a bad session id, never reaches Stripe", async () => {
  assert.equal((await handleBillingDone({ sessionId: SID }, { env: { ...ENV, SIGHTWORK_BILLING: "" }, fetchImpl: never })).status, 404);
  for (const sessionId of [undefined, "", "cs_live", "../x", "cus_123456789", SID + "/../x"])
    assert.equal((await handleBillingDone({ sessionId }, { env: ENV, fetchImpl: never })).status, 400);
  assert.equal((await handleBillingDone(null, { env: ENV, fetchImpl: never })).status, 400);
});

test("a paid pack makes a customer code that verifies in the matching mode only", async () => {
  const seen: string[] = [];
  const r = await handleBillingDone(
    { sessionId: SID },
    {
      env: ENV,
      now: () => 1_800_000_000_000,
      fetchImpl: stripe(200, { mode: "payment", payment_status: "paid", livemode: false, customer: "cus_Abc123456", metadata: { sightwork_plan: "pack5" } }, seen),
    },
  );
  assert.equal(r.status, 200);
  assert.deepEqual(seen, [`GET https://api.stripe.com/v1/checkout/sessions/${SID}`]);
  const b = r.body as { code: string; kind: string; plan: string };
  assert.equal(b.kind, "pack");
  assert.equal(b.plan, "5-Plan Pack");
  const v = verifyAccessCode(b.code, { live: false, secret: SECRET });
  assert.ok(v.ok && v.grant.stripeId === "cus_Abc123456" && v.grant.issuedAt === 1_800_000_000);
  assert.equal(verifyAccessCode(b.code, { live: true, secret: SECRET }).ok, false);
});

test("a completed subscription makes a subscription code, even with an expanded object", async () => {
  const r = await handleBillingDone(
    { sessionId: SID },
    { env: ENV, fetchImpl: stripe(200, { mode: "subscription", status: "complete", payment_status: "paid", livemode: true, subscription: { id: "sub_Abc123456" }, metadata: { sightwork_plan: "church-yearly" } }) },
  );
  assert.equal(r.status, 200);
  const v = verifyAccessCode((r.body as { code: string }).code, { live: true, secret: SECRET });
  assert.ok(v.ok && v.grant.kind === "sub" && v.grant.stripeId === "sub_Abc123456");
});

test("unpaid sessions get no code, and foreign or mismatched sessions are refused", async () => {
  const unpaid = await handleBillingDone({ sessionId: SID }, { env: ENV, fetchImpl: stripe(200, { mode: "payment", payment_status: "unpaid", livemode: false, customer: "cus_Abc123456", metadata: { sightwork_plan: "single" } }) });
  assert.equal(unpaid.status, 202);
  assert.ok(!("code" in unpaid.body));
  for (const j of [
    { mode: "payment", payment_status: "paid", livemode: false, customer: "cus_Abc123456", metadata: {} },
    { mode: "subscription", payment_status: "paid", status: "complete", livemode: false, subscription: "sub_Abc123456", metadata: { sightwork_plan: "single" } },
  ]) {
    const r = await quiet(() => handleBillingDone({ sessionId: SID }, { env: ENV, fetchImpl: stripe(200, j) }));
    assert.equal(r.status, 503);
    assert.ok(!JSON.stringify(r.body).includes("cus_"));
  }
});

test("Stripe errors and missing settings give one plain line with no detail", async () => {
  assert.equal((await handleBillingDone({ sessionId: SID }, { env: ENV, fetchImpl: stripe(404, {}) })).status, 404);
  const down = await quiet(() => handleBillingDone({ sessionId: SID }, { env: ENV, fetchImpl: stripe(500, { error: "boom sk_test_abc123" }) }));
  assert.equal(down.status, 503);
  assert.ok(!JSON.stringify(down.body).includes("boom"));
  for (const env of [{ ...ENV, STRIPE_SECRET_KEY: "" }, { ...ENV, SIGHTWORK_ACCESS_SECRET: "short" }])
    assert.equal((await quiet(() => handleBillingDone({ sessionId: SID }, { env, fetchImpl: never }))).status, 503);
});
