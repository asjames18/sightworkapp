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
  assert.deepEqual(await checkEntitlement(sub, { env: ENV, fetchImpl: stripe(200, { status: "active" }) }), { allowed: true, kind: "sub", stripeId: "sub_Abc123456" });
  assert.deepEqual(await checkEntitlement(sub, { env: ENV, fetchImpl: stripe(200, { status: "trialing" }) }), { allowed: true, kind: "sub", stripeId: "sub_Abc123456" });
  assert.deepEqual(await checkEntitlement(sub, { env: ENV, fetchImpl: stripe(200, { status: "canceled" }) }), { allowed: false, reason: "inactive" });
  assert.deepEqual(await checkEntitlement(sub, { env: ENV, fetchImpl: stripe(404, {}) }), { allowed: false, reason: "inactive" });
  assert.deepEqual(await checkEntitlement(sub, { env: ENV, fetchImpl: stripe(500, {}) }), { allowed: false, reason: "unavailable" });
  assert.deepEqual(await checkEntitlement(pack, { env: ENV, fetchImpl: stripe(200, { deleted: true }) }), { allowed: false, reason: "inactive" });
});

const paid = (plan: string, id = "cs_" + plan) => ({ id, mode: "payment", payment_status: "paid", metadata: { sightwork_plan: plan } });
function packStripe(customer: unknown, pages: Array<{ data: unknown[]; has_more?: boolean }>, seen: string[] = []) {
  let i = 0;
  return async (url: string) => {
    seen.push(url);
    if (url.includes("/customers/")) return { ok: true, status: 200, json: async () => customer };
    const p = pages[i++] ?? { data: [] };
    return { ok: true, status: 200, json: async () => p };
  };
}

test("a pack code works until the plans used reach the plans bought", async () => {
  const ok = { allowed: true, kind: "pack", stripeId: "cus_Abc123456" };
  const seen: string[] = [];
  assert.deepEqual(await checkEntitlement(pack, { env: ENV, fetchImpl: packStripe({ metadata: {} }, [{ data: [paid("single")] }], seen) }), ok);
  assert.match(seen[1], /\/checkout\/sessions\?customer=cus_Abc123456&status=complete&limit=100$/);
  assert.deepEqual(await checkEntitlement(pack, { env: ENV, fetchImpl: packStripe({ metadata: { sightwork_plans_used: "1" } }, [{ data: [paid("single")] }]) }), { allowed: false, reason: "used-up" });
  assert.deepEqual(await checkEntitlement(pack, { env: ENV, fetchImpl: packStripe({ metadata: { sightwork_plans_used: "5" } }, [{ data: [paid("pack5"), paid("single", "cs_b")] }]) }), ok);
  assert.deepEqual(await checkEntitlement(pack, { env: ENV, fetchImpl: packStripe({ metadata: { sightwork_plans_used: "6" } }, [{ data: [paid("pack5"), paid("single", "cs_b")] }]) }), { allowed: false, reason: "used-up" });
});

test("unpaid, subscription and unknown sessions add no plans; later pages are read", async () => {
  const junk = [
    { mode: "payment", payment_status: "unpaid", metadata: { sightwork_plan: "pack5" } },
    { mode: "subscription", payment_status: "paid", metadata: { sightwork_plan: "church-monthly" } },
    { mode: "payment", payment_status: "paid", metadata: { sightwork_plan: "nope" } },
    null,
  ];
  assert.deepEqual(await checkEntitlement(pack, { env: ENV, fetchImpl: packStripe({ metadata: {} }, [{ data: junk }]) }), { allowed: false, reason: "used-up" });
  const seen: string[] = [];
  const r = await checkEntitlement(pack, {
    env: ENV,
    fetchImpl: packStripe({ metadata: {} }, [{ data: [{ id: "cs_x", mode: "payment", payment_status: "unpaid" }], has_more: true }, { data: [paid("single")] }], seen),
  });
  assert.deepEqual(r, { allowed: true, kind: "pack", stripeId: "cus_Abc123456" });
  assert.match(seen[2], /starting_after=cs_x/);
});

test("a failed session list is unavailable, not a refusal", async () => {
  const f = async (url: string) =>
    url.includes("/customers/") ? { ok: true, status: 200, json: async () => ({ metadata: {} }) } : { ok: false, status: 500, json: async () => ({}) };
  assert.deepEqual(await checkEntitlement(pack, { env: ENV, fetchImpl: f }), { allowed: false, reason: "unavailable" });
});
