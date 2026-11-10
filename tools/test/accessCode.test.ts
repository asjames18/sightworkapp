import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  MAX_ACCESS_CODE_LENGTH,
  accessSecret,
  billingEnabled,
  issueAccessCode,
  verifyAccessCode,
  type AccessGrant,
} from "../../src/lib/billing/accessCode";

const SECRET = "test-secret-0123456789-abcdefghijklmnop";
const OTHER = "other-secret-0123456789-abcdefghijklmno";
const PACK: AccessGrant = { kind: "pack", stripeId: "cus_TestCustomer01", live: false, issuedAt: 1_800_000_000 };
const SUB: AccessGrant = { kind: "sub", stripeId: "sub_TestSubscription1", live: false, issuedAt: 1_800_000_000 };

test("billing is off unless the flag says on", () => {
  assert.equal(billingEnabled(undefined), false);
  assert.equal(billingEnabled(""), false);
  assert.equal(billingEnabled("true"), false);
  assert.equal(billingEnabled("on"), true);
});

test("a short or missing secret is not trusted", () => {
  assert.equal(accessSecret(undefined), null);
  assert.equal(accessSecret("short"), null);
  assert.equal(accessSecret(`  ${SECRET}  `), SECRET);
});

test("pack and subscription codes round-trip", () => {
  for (const g of [PACK, SUB]) {
    const code = issueAccessCode(g, SECRET);
    assert.match(code, /^sw1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    assert.deepEqual(verifyAccessCode(code, { live: false, secret: SECRET }), { ok: true, grant: g });
    assert.deepEqual(verifyAccessCode(` ${code} `, { live: false, secret: SECRET }), { ok: true, grant: g });
  }
});

test("issuing needs a secret and a valid grant", () => {
  assert.throws(() => issueAccessCode(PACK, null), /secret is not set/);
  assert.throws(() => issueAccessCode({ ...PACK, stripeId: "sub_TestSubscription1" }, SECRET), /customer id/);
  assert.throws(() => issueAccessCode({ ...SUB, stripeId: "cus_TestCustomer01" }, SECRET), /customer id/);
  assert.throws(() => issueAccessCode({ ...PACK, stripeId: "pi_123456789" }, SECRET), /Stripe customer/);
  assert.throws(() => issueAccessCode({ ...PACK, kind: "free" as never }, SECRET), /pack or sub/);
  assert.throws(() => issueAccessCode({ ...PACK, issuedAt: 1.5 }, SECRET), /whole seconds/);
});

test("a code signed with another secret is refused", () => {
  const code = issueAccessCode(PACK, OTHER);
  assert.deepEqual(verifyAccessCode(code, { live: false, secret: SECRET }), { ok: false, reason: "bad-signature" });
});

test("a changed payload is refused", () => {
  const code = issueAccessCode(PACK, SECRET);
  const [v, , sig] = code.split(".");
  const forged = Buffer.from(JSON.stringify({ k: "pack", id: "cus_SomeoneElse01", l: 0, t: 1 })).toString("base64url");
  assert.deepEqual(verifyAccessCode(`${v}.${forged}.${sig}`, { live: false, secret: SECRET }), {
    ok: false,
    reason: "bad-signature",
  });
});

test("a test-mode code is refused on live and the reverse", () => {
  const testCode = issueAccessCode(PACK, SECRET);
  const liveCode = issueAccessCode({ ...SUB, live: true }, SECRET);
  assert.deepEqual(verifyAccessCode(testCode, { live: true, secret: SECRET }), { ok: false, reason: "wrong-mode" });
  assert.deepEqual(verifyAccessCode(liveCode, { live: false, secret: SECRET }), { ok: false, reason: "wrong-mode" });
  assert.equal(verifyAccessCode(liveCode, { live: true, secret: SECRET }).ok, true);
});

test("missing and malformed codes are refused without throwing", () => {
  assert.deepEqual(verifyAccessCode(undefined, { live: false, secret: SECRET }), { ok: false, reason: "missing" });
  assert.deepEqual(verifyAccessCode("   ", { live: false, secret: SECRET }), { ok: false, reason: "missing" });
  for (const bad of ["sw1", "sw2.a.b", "sw1.a.b.c", "sw1.a+b.c", "x".repeat(MAX_ACCESS_CODE_LENGTH + 1)]) {
    assert.equal(verifyAccessCode(bad, { live: false, secret: SECRET }).ok, false, bad.slice(0, 20));
  }
  // A correctly signed payload that is not a valid grant is still refused.
  const payload = Buffer.from(JSON.stringify({ k: "pack", id: "sub_TestSubscription1", l: 0, t: 1 })).toString("base64url");
  const sig = createHmac("sha256", SECRET).update(`sw1.${payload}`).digest("base64url");
  assert.deepEqual(verifyAccessCode(`sw1.${payload}.${sig}`, { live: false, secret: SECRET }), {
    ok: false,
    reason: "malformed",
  });
});

test("without a secret on the server every code is refused", () => {
  const code = issueAccessCode(PACK, SECRET);
  assert.equal(verifyAccessCode(code, { live: false, secret: null }).ok, false);
});
