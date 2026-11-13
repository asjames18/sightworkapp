/** The two ways to make plans from your own video, and when the app asks which one first. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { codeFieldLabel, needsRunChoice, paidPlansOn, PRICING_HREF, runOptions, SETTINGS_HREF } from "../../src/lib/client/runAccess";
import { ACCESS_CODE_MESSAGE, isPaidRefusal, isResumeFailure, PAID_PLAN_MESSAGE, TESTER_CODE_MESSAGE, USED_UP_MESSAGE } from "../../src/lib/client/apiPlanJob";

test("paid plans are on only for an exact on", () => {
  assert.equal(paidPlansOn("on"), true);
  assert.equal(paidPlansOn(" ON "), true);
  for (const v of [undefined, "", "off", "1", "true"]) assert.equal(paidPlansOn(v), false, String(v));
});

test("both ways are offered, own key first because it is free, each with its page", () => {
  const both = runOptions(true, true);
  assert.deepEqual(both.map((o) => o.key), ["own-key", "buy"]);
  assert.equal(both[0].label, "Use your own key (free)");
  assert.equal(both[0].href, SETTINGS_HREF);
  assert.equal(both[1].label, "Buy plans");
  assert.equal(both[1].href, PRICING_HREF);
  assert.deepEqual(runOptions(false, true).map((o) => o.key), ["own-key"]);
  assert.deepEqual(runOptions(true, false).map((o) => o.key), ["buy"]);
  assert.deepEqual(runOptions(false, false), []);
});

test("only a server run with nothing saved asks first", () => {
  assert.equal(needsRunChoice("api", ""), true);
  assert.equal(needsRunChoice("api", "   "), true);
  assert.equal(needsRunChoice("api", "sw1.abc"), false);
  assert.equal(needsRunChoice("own", ""), false);
  assert.equal(needsRunChoice("mock", ""), false);
});

test("the code field says access code once paid plans are on", () => {
  assert.equal(codeFieldLabel(true), "Access code");
  assert.equal(codeFieldLabel(false), "Tester code for real runs");
});

test("payment refusals are told apart and send the visitor back to the choice", () => {
  for (const m of [PAID_PLAN_MESSAGE, ACCESS_CODE_MESSAGE, USED_UP_MESSAGE]) {
    assert.equal(isPaidRefusal(m), true, m);
    assert.equal(isResumeFailure(m), true, m);
  }
  assert.equal(isPaidRefusal(TESTER_CODE_MESSAGE), false);
  assert.equal(isPaidRefusal("Something else went wrong."), false);
});
