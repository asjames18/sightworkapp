import { test } from "node:test";
import assert from "node:assert/strict";
import { deviceFromWidth, pageKey, usageDetail, USAGE_NOTE } from "@/lib/usage/events";

test("pageKey keeps listed pages only and drops queries, ids and admin pages", () => {
  assert.equal(pageKey("/"), "/");
  assert.equal(pageKey("/pricing?email=someone@example.com"), "/pricing");
  assert.equal(pageKey("/start/"), "/start");
  assert.equal(pageKey("/start/example/kitchen"), "/start/example");
  assert.equal(pageKey("/help/own-key#top"), "/help/own-key");
  assert.equal(pageKey("/some/user/typed/path"), "other");
  assert.equal(pageKey("/admin/usage"), null);
  for (const bad of ["", "pricing", "https://evil.example/", 5, null, "/" + "a".repeat(300)]) assert.equal(pageKey(bad), null, String(bad));
});

test("usageDetail allows only fixed details per event", () => {
  assert.equal(usageDetail("plan_started", "byok"), "byok");
  assert.equal(usageDetail("plan_done", "code"), "code");
  assert.equal(usageDetail("plan_failed", "mock"), null);
  assert.equal(usageDetail("plan_started", "sk_live_abc"), null);
  assert.equal(usageDetail("checkout_started", "pack5"), "pack5");
  assert.equal(usageDetail("checkout_started", "Someone@Example.com"), "");
  assert.equal(usageDetail("checkout_done", "anything"), "");
  assert.equal(usageDetail("recover_used", "a@b.co"), "");
});

test("deviceFromWidth gives a coarse class only", () => {
  assert.equal(deviceFromWidth(390), "phone");
  assert.equal(deviceFromWidth(800), "tablet");
  assert.equal(deviceFromWidth(1440), "desktop");
  for (const bad of [0, -1, NaN, Infinity, "1440", undefined]) assert.equal(deviceFromWidth(bad), "", String(bad));
});

test("the public note says what is and isn't kept", () => {
  assert.match(USAGE_NOTE, /anonymous daily totals/);
  for (const word of ["cookies", "names", "emails", "IP addresses", "codes", "keys", "videos", "plans"]) assert.ok(USAGE_NOTE.includes(word), word);
  assert.doesNotMatch(USAGE_NOTE, /free|\$/i);
});
