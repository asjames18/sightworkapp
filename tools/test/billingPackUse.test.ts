import { test } from "node:test";
import assert from "node:assert/strict";
import { recordPackUse, plansUsed, PLANS_USED_KEY } from "@/lib/billing/packUse";

const ENV = { STRIPE_SECRET_KEY: "sk_test_abc123" };
const never = async () => {
  throw new Error("must not call Stripe");
};
type Call = { url: string; method: string; body?: string; auth?: string };

function fake(customer: unknown, opts: { getStatus?: number; postStatus?: number } = {}) {
  const calls: Call[] = [];
  const impl = async (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
    calls.push({ url, method: init.method, body: init.body, auth: init.headers.Authorization });
    const status = init.method === "GET" ? (opts.getStatus ?? 200) : (opts.postStatus ?? 200);
    return { ok: status < 300, status, json: async () => customer };
  };
  return { calls, impl };
}

test("plansUsed reads only whole non-negative counts", () => {
  assert.equal(plansUsed(undefined), 0);
  assert.equal(plansUsed({}), 0);
  assert.equal(plansUsed({ [PLANS_USED_KEY]: "3" }), 3);
  for (const bad of ["-1", "1.5", "abc", "", "9999999", 4]) assert.equal(plansUsed({ [PLANS_USED_KEY]: bad }), 0, String(bad));
});

test("bad ids and missing keys never reach Stripe", async () => {
  for (const id of ["", "sub_Abc123456", "cus_x", "cus_Abc123456/../x"])
    assert.deepEqual(await recordPackUse(id, { env: ENV, fetchImpl: never }), { ok: false, reason: "bad-id" }, id);
  assert.deepEqual(await recordPackUse("cus_Abc123456", { env: {}, fetchImpl: never }), { ok: false, reason: "no-key" });
  assert.deepEqual(await recordPackUse("cus_Abc123456", { env: { STRIPE_SECRET_KEY: "pk_test_1" }, fetchImpl: never }), { ok: false, reason: "no-key" });
});

test("adds one to the stored count and writes it back", async () => {
  const { calls, impl } = fake({ id: "cus_Abc123456", metadata: { [PLANS_USED_KEY]: "2", other: "x" } });
  assert.deepEqual(await recordPackUse("cus_Abc123456", { env: ENV, fetchImpl: impl }), { ok: true, used: 3 });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].method, "GET");
  assert.equal(calls[0].body, undefined);
  assert.equal(calls[1].method, "POST");
  assert.equal(calls[1].url, "https://api.stripe.com/v1/customers/cus_Abc123456");
  assert.equal(calls[1].body, "metadata%5Bsightwork_plans_used%5D=3");
  assert.equal(calls[1].auth, "Bearer sk_test_abc123");
});

test("starts at one when nothing was counted", async () => {
  const { impl } = fake({ id: "cus_Abc123456" });
  assert.deepEqual(await recordPackUse("cus_Abc123456", { env: ENV, fetchImpl: impl }), { ok: true, used: 1 });
});

test("Stripe errors, deleted customers and network failures report, never throw", async () => {
  assert.deepEqual(await recordPackUse("cus_Abc123456", { env: ENV, fetchImpl: fake({}, { getStatus: 404 }).impl }), { ok: false, reason: "stripe" });
  assert.deepEqual(await recordPackUse("cus_Abc123456", { env: ENV, fetchImpl: fake({}, { postStatus: 500 }).impl }), { ok: false, reason: "stripe" });
  const del = fake({ deleted: true });
  assert.deepEqual(await recordPackUse("cus_Abc123456", { env: ENV, fetchImpl: del.impl }), { ok: false, reason: "stripe" });
  assert.equal(del.calls.length, 1);
  assert.deepEqual(await recordPackUse("cus_Abc123456", { env: ENV, fetchImpl: never }), { ok: false, reason: "stripe" });
});
