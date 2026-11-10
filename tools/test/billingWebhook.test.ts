/** Stripe webhook: signature checked on the raw body, replays are harmless, nothing is stored. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { handleBillingWebhook, verifyStripeSignature } from "@/lib/billing/webhook";

const WH = "whsec_" + "a".repeat(32);
const ENV = { SIGHTWORK_BILLING: "on", STRIPE_WEBHOOK_SECRET: WH };
const NOW = 1_800_000_000;
const now = () => NOW * 1000;
const sign = (raw: string, t = NOW, secret = WH) => `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${raw}`).digest("hex")}`;
const ev = (type: string, id = "evt_1") => JSON.stringify({ id, type, livemode: false });
const quiet = <T>(fn: () => T): T => {
  const l = console.log, e = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    return fn();
  } finally {
    console.log = l;
    console.error = e;
  }
};

test("a correctly signed handled event is accepted", () => {
  const raw = ev("checkout.session.completed");
  const r = quiet(() => handleBillingWebhook(raw, sign(raw), { env: ENV, now }));
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { received: true, handled: true, id: "evt_1", type: "checkout.session.completed" });
});

test("unknown event types are acknowledged but not handled", () => {
  const raw = ev("charge.refunded");
  const r = quiet(() => handleBillingWebhook(raw, sign(raw), { env: ENV, now }));
  assert.equal(r.status, 200);
  assert.equal((r.body as { handled: boolean }).handled, false);
});

test("the same delivery twice gives the same answer", () => {
  const raw = ev("invoice.paid");
  const a = quiet(() => handleBillingWebhook(raw, sign(raw), { env: ENV, now }));
  const b = quiet(() => handleBillingWebhook(raw, sign(raw), { env: ENV, now }));
  assert.deepEqual(a, b);
});

test("bad, missing, wrong-secret, tampered and malformed signatures are refused", () => {
  const raw = ev("invoice.paid");
  const bad = [
    null,
    "",
    "garbage",
    `t=${NOW},v1=${"0".repeat(64)}`,
    `t=${NOW},v1=zz`,
    sign(raw, NOW, "whsec_" + "b".repeat(32)),
    sign(raw + " "),
    `v1=${"0".repeat(64)}`,
  ];
  for (const h of bad) assert.equal(quiet(() => handleBillingWebhook(raw, h, { env: ENV, now })).status, 400, String(h));
});

test("old and far-future timestamps are refused, the edge is allowed", () => {
  const raw = ev("invoice.paid");
  assert.equal(verifyStripeSignature(raw, sign(raw, NOW - 301), WH, NOW), false);
  assert.equal(verifyStripeSignature(raw, sign(raw, NOW + 301), WH, NOW), false);
  assert.equal(verifyStripeSignature(raw, sign(raw, NOW - 300), WH, NOW), true);
});

test("any one matching v1 among several is enough", () => {
  const raw = ev("invoice.paid");
  const good = sign(raw);
  assert.equal(verifyStripeSignature(raw, `${good},v1=${"1".repeat(64)}`, WH, NOW), true);
  assert.equal(verifyStripeSignature(raw, `t=${NOW},v1=${"1".repeat(64)},${good.split(",")[1]}`, WH, NOW), true);
});

test("signed but malformed payloads are refused", () => {
  for (const raw of ["not json", "{}", JSON.stringify({ id: 1, type: "x" })]) {
    assert.equal(quiet(() => handleBillingWebhook(raw, sign(raw), { env: ENV, now })).status, 400);
  }
});

test("404 when billing is off, 503 when the secret is missing or malformed", () => {
  const raw = ev("invoice.paid");
  assert.equal(handleBillingWebhook(raw, sign(raw), { env: { ...ENV, SIGHTWORK_BILLING: "" }, now }).status, 404);
  assert.equal(quiet(() => handleBillingWebhook(raw, sign(raw), { env: { SIGHTWORK_BILLING: "on" }, now })).status, 503);
  assert.equal(quiet(() => handleBillingWebhook(raw, sign(raw), { env: { ...ENV, STRIPE_WEBHOOK_SECRET: "nope" }, now })).status, 503);
});

test("the log line carries no payload data", () => {
  const raw = JSON.stringify({ id: "evt_9", type: "invoice.paid", data: { email: "a@b.co" } });
  const lines: string[] = [];
  const l = console.log;
  console.log = (s: string) => lines.push(s);
  try {
    handleBillingWebhook(raw, sign(raw), { env: ENV, now });
  } finally {
    console.log = l;
  }
  assert.equal(lines.length, 1);
  assert.ok(!lines[0].includes("a@b.co"));
});
