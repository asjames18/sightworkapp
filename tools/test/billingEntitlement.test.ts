import { test } from "node:test";
import assert from "node:assert/strict";
import { checkEntitlement } from "@/lib/billing/entitlement";
import { issueAccessCode } from "@/lib/billing/accessCode";

const SECRET = "x".repeat(40);
const ENV = { SIGHTWORK_BILLING: "on", STRIPE_SECRET_KEY: "sk_test_abc123", SIGHTWORK_ACCESS_SECRET: SECRET };
const sub = issueAccessCode({ kind: "sub", stripeId: "sub_Abc123456", live: false, issuedAt: 1 }, SECRET);
const pack = issueAccessCode({ kind: "pack", stripeId: "cus_Abc123456", live: false, issuedAt: 1 }, SECRET);
const never = async () => {
  throw new Error("must not call Stripe");
};
const stripe = (status: number, json: unknown) => async () => ({ ok: status < 300, status, json: async () => json });

test("off, bad, or wrong-mode codes never reach Stripe", async () => {
  assert.deepEqual(await checkEntitlement(sub, { env: { ...ENV, SIGHTWORK_BILLING: "" }, fetchImpl: never }), { allowed: false, reason: "off" });
  assert.deepEqual(await checkEntitlement("sw1.a.b", { env: ENV, fetchImpl: never }), { allowed: false, reason: "invalid" });
  assert.deepEqual(await checkEntitlement(null, { env: ENV, fetchImpl: never }), { allowed: false, reason: "invalid" });
  assert.deepEqual(await checkEntitlement(sub, { env: { SIGHTWORK_BILLING: "on" }, fetchImpl: never }), { allowed: false, reason: "unavailable" });
});

test("subscriptions need an active or trialing status; packs need a live customer", async () => {
  assert.deepEqual(await checkEntitlement(sub, { env: ENV, fetchImpl: stripe(200, { status: "active" }) }), { allowed: true, kind: "sub" });
  assert.deepEqual(await checkEntitlement(sub, { env: ENV, fetchImpl: stripe(200, { status: "trialing" }) }), { allowed: true, kind: "sub" });
  assert.deepEqual(await checkEntitlement(sub, { env: ENV, fetchImpl: stripe(200, { status: "canceled" }) }), { allowed: false, reason: "inactive" });
  assert.deepEqual(await checkEntitlement(sub, { env: ENV, fetchImpl: stripe(404, {}) }), { allowed: false, reason: "inactive" });
  assert.deepEqual(await checkEntitlement(sub, { env: ENV, fetchImpl: stripe(500, {}) }), { allowed: false, reason: "unavailable" });
  assert.deepEqual(await checkEntitlement(pack, { env: ENV, fetchImpl: stripe(200, { id: "cus_Abc123456" }) }), { allowed: true, kind: "pack" });
  assert.deepEqual(await checkEntitlement(pack, { env: ENV, fetchImpl: stripe(200, { deleted: true }) }), { allowed: false, reason: "inactive" });
});
