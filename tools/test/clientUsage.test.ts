import { test } from "node:test";
import assert from "node:assert/strict";
import { beaconBody, countedRun, optedOut, usageOn } from "@/lib/client/usage";
import type { PlanJobRunner } from "@/lib/client/planJob";
import type { PlanJobStatus } from "@/lib/types";

test("usage is on only for the exact build flag", () => {
  assert.equal(usageOn("on"), true);
  for (const v of ["off", "", "ON", undefined]) assert.equal(usageOn(v), false, String(v));
});

test("Global Privacy Control, Do Not Track and automation turn counting off", () => {
  assert.equal(optedOut({}), false);
  assert.equal(optedOut({ globalPrivacyControl: true }), true);
  assert.equal(optedOut({ doNotTrack: "1" }), true);
  assert.equal(optedOut({ webdriver: true }), true);
  assert.equal(optedOut(undefined), true);
});

test("the beacon carries event, detail and device class only", () => {
  assert.deepEqual(JSON.parse(beaconBody("view", "/start", 390)), { e: "view", d: "/start", v: "phone" });
  assert.deepEqual(Object.keys(JSON.parse(beaconBody("plan_done", "byok", undefined))), ["e", "d", "v"]);
});

function input(signal = new AbortController().signal) {
  const seen: PlanJobStatus[] = [];
  return { seen, input: { file: new Blob([]) as File, signal, onStatus: (s: PlanJobStatus) => seen.push(s) } };
}

test("countedRun counts start and one finish, and passes every status through", async () => {
  const sent: string[] = [];
  const runner: PlanJobRunner = async ({ onStatus }) => {
    onStatus({ state: "running", step: "uploading" });
    onStatus({ state: "done", plan: {} as never });
    onStatus({ state: "done", plan: {} as never });
  };
  const { seen, input: i } = input();
  await countedRun("byok", runner, (e, d) => sent.push(`${e}:${d}`))(i);
  assert.deepEqual(sent, ["plan_started:byok", "plan_done:byok"]);
  assert.equal(seen.length, 3);
});

test("countedRun counts a failure, a throw, and nothing after leaving", async () => {
  const sent: string[] = [];
  const send = (e: string, d: string) => sent.push(`${e}:${d}`);
  await countedRun("code", async ({ onStatus }) => onStatus({ state: "failed", step: "looking", message: "x" }), send)(input().input);
  await assert.rejects(countedRun("code", async () => { throw new Error("boom"); }, send)(input().input));
  const c = new AbortController();
  c.abort();
  await countedRun("code", async ({ onStatus }) => onStatus({ state: "done", plan: {} as never }), send)(input(c.signal).input);
  assert.deepEqual(sent, ["plan_started:code", "plan_failed:code", "plan_started:code", "plan_failed:code", "plan_started:code"]);
});
