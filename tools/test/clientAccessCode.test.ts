/** Paid access codes on the client: kept after a purchase, sent on server plan runs. No network. */
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { ACCESS_CODE_HEADER, loadAccessCode, looksLikeAccessCode, saveAccessCode } from "@/lib/client/accessCode";
import { ACCESS_CODE_MESSAGE, createApiPlanJob, PAID_PLAN_MESSAGE, TESTER_CODE_MESSAGE, USED_UP_MESSAGE, WRONG_CODE_MESSAGE } from "@/lib/client/apiPlanJob";
import { saveLocation } from "@/lib/client/location";
import { saveTestCode, TEST_CODE_HEADER } from "@/lib/client/testCode";
import type { PlanJobStatus, PlanRequest } from "@/lib/types";
import { fakeWindow, noWindow } from "./browser-stubs";

afterEach(noWindow);

const CODE = "sw1.eyJrIjoicGFjayJ9.c2lnbmF0dXJl";

describe("access code storage", () => {
  test("only code-shaped values are kept; anything else clears the saved one", () => {
    fakeWindow();
    assert.equal(looksLikeAccessCode(CODE), true);
    assert.equal(looksLikeAccessCode("tester"), false);
    assert.equal(looksLikeAccessCode("sw1."), false);
    assert.equal(looksLikeAccessCode("sw1.a b"), false);
    assert.equal(looksLikeAccessCode("sw1." + "a".repeat(600)), false);
    assert.equal(saveAccessCode(`  ${CODE} `), true);
    assert.equal(loadAccessCode(), CODE);
    assert.equal(saveAccessCode("nope"), false);
    assert.equal(loadAccessCode(), "");
  });
  test("no window means no code, and saving never throws", () => {
    assert.equal(loadAccessCode(), "");
    assert.equal(saveAccessCode(CODE), false);
  });
});

type Seen = { url: string; headers: Record<string, string>; body: PlanRequest };

async function run(status = 200, failBody: unknown = { error: "x" }, audio = true): Promise<{ statuses: PlanJobStatus[]; seen: Seen[] }> {
  const realFetch = globalThis.fetch;
  const seen: Seen[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    seen.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
    if (status !== 200) return new Response(JSON.stringify(failBody), { status });
    return new Response(JSON.stringify({ state: "done", plan: { spaceName: "Stage", issues: [], steps: [], materials: [], inventory: [] } }) + "\n", {
      status: 200,
      headers: { "Content-Type": "application/x-ndjson" },
    });
  }) as typeof fetch;
  const statuses: PlanJobStatus[] = [];
  const err = console.error;
  console.error = () => {};
  try {
    const req: PlanRequest = { durationSec: 30, frames: [{ tSec: 0, dataUrl: "data:image/jpeg;base64,AA==" }], ...(audio ? { audioWavBase64: "UklGRg==" } : {}) };
    await createApiPlanJob(async () => req)({ file: {} as File, onStatus: (s) => statuses.push(s), signal: new AbortController().signal });
  } finally {
    globalThis.fetch = realFetch;
    console.error = err;
  }
  return { statuses, seen };
}

const last = (s: PlanJobStatus[]) => s[s.length - 1];

describe("server plan runs with an access code", () => {
  test("an access code alone opens the run and rides in its own header on the split transcribe call and the plan", async () => {
    fakeWindow();
    saveAccessCode(CODE);
    saveLocation({ city: "Sebring", state: "FL" });
    const { statuses, seen } = await run();
    assert.equal(last(statuses).state, "done");
    assert.equal(seen[0].url, "/api/transcribe");
    assert.equal(seen[0].headers[ACCESS_CODE_HEADER], CODE);
    assert.equal(seen[0].headers[TEST_CODE_HEADER], undefined);
    const plan = seen.find((s) => s.url === "/api/plan");
    assert.ok(plan);
    assert.equal(plan.headers[ACCESS_CODE_HEADER], CODE);
    assert.equal(plan.headers[TEST_CODE_HEADER], undefined);
  });
  test("with both codes, both headers go and the narration still splits", async () => {
    fakeWindow();
    saveAccessCode(CODE);
    saveTestCode("tester");
    saveLocation({ city: "Sebring", state: "FL" });
    const { seen } = await run();
    assert.equal(seen[0].url, "/api/transcribe");
    const plan = seen.find((s) => s.url === "/api/plan");
    assert.ok(plan);
    assert.equal(plan.headers[ACCESS_CODE_HEADER], CODE);
    assert.equal(plan.headers[TEST_CODE_HEADER], "tester");
  });
  test("a refused access code (402) says so plainly, not as a tester-code failure", async () => {
    fakeWindow();
    saveAccessCode(CODE);
    saveLocation({ city: "Sebring", state: "FL" });
    const { statuses, seen } = await run(402);
    const s = last(statuses);
    assert.ok(s.state === "failed");
    assert.equal(s.message, ACCESS_CODE_MESSAGE);
    assert.deepEqual(seen.map((x) => x.url), ["/api/transcribe"], "a refused code stops before the plan request");
  });
  test("a used-up pack (402, reason used-up) says so on the narration call and on the plan call", async () => {
    fakeWindow();
    saveAccessCode(CODE);
    saveLocation({ city: "Sebring", state: "FL" });
    const a = await run(402, { error: "x", reason: "used-up" });
    const sa = last(a.statuses);
    assert.ok(sa.state === "failed");
    assert.equal(sa.message, USED_UP_MESSAGE);
    assert.deepEqual(a.seen.map((x) => x.url), ["/api/transcribe"]);
    const b = await run(402, { error: "x", reason: "used-up" }, false);
    const sb = last(b.statuses);
    assert.ok(sb.state === "failed");
    assert.equal(sb.message, USED_UP_MESSAGE);
    assert.deepEqual(b.seen.map((x) => x.url), ["/api/plan"]);
    const c = await run(402, { error: "x", reason: "inactive" }, false);
    const sc = last(c.statuses);
    assert.ok(sc.state === "failed");
    assert.equal(sc.message, ACCESS_CODE_MESSAGE, "any other reason keeps the inactive-code text");
  });
  test("used-up with no access code sent still points to a paid plan", async () => {
    fakeWindow();
    saveTestCode("tester");
    saveLocation({ city: "Sebring", state: "FL" });
    const s = last((await run(402, { error: "x", reason: "used-up" }, false)).statuses);
    assert.ok(s.state === "failed");
    assert.equal(s.message, PAID_PLAN_MESSAGE);
  });
  test("a 401 with only an access code asks for a tester code; with a tester code it says the code was refused", async () => {
    fakeWindow();
    saveAccessCode(CODE);
    saveLocation({ city: "Sebring", state: "FL" });
    const a = last((await run(401)).statuses);
    assert.ok(a.state === "failed");
    assert.equal(a.message, TESTER_CODE_MESSAGE);
    noWindow();
    fakeWindow();
    saveTestCode("tester");
    saveLocation({ city: "Sebring", state: "FL" });
    const req: PlanRequest = { durationSec: 30, frames: [{ tSec: 0, dataUrl: "data:image/jpeg;base64,AA==" }] };
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response("{}", { status: 401 })) as typeof fetch;
    const st: PlanJobStatus[] = [];
    try {
      await createApiPlanJob(async () => req)({ file: {} as File, onStatus: (x) => st.push(x), signal: new AbortController().signal });
    } finally {
      globalThis.fetch = realFetch;
    }
    const b = last(st);
    assert.ok(b.state === "failed");
    assert.equal(b.message, WRONG_CODE_MESSAGE);
  });
  test("with billing on, a tester code alone gets 402 and is pointed to a paid plan or an own key", async () => {
    fakeWindow();
    saveTestCode("tester");
    saveLocation({ city: "Sebring", state: "FL" });
    const { statuses, seen } = await run(402);
    const s = last(statuses);
    assert.ok(s.state === "failed");
    assert.equal(s.message, PAID_PLAN_MESSAGE);
    assert.deepEqual(seen.map((x) => x.url), ["/api/transcribe"], "stops before the plan request");
    noWindow();
    fakeWindow();
    saveTestCode("tester");
    saveLocation({ city: "Sebring", state: "FL" });
    const req: PlanRequest = { durationSec: 30, frames: [{ tSec: 0, dataUrl: "data:image/jpeg;base64,AA==" }] };
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response("{}", { status: 402 })) as typeof fetch;
    const st: PlanJobStatus[] = [];
    const err = console.error;
    console.error = () => {};
    try {
      await createApiPlanJob(async () => req)({ file: {} as File, onStatus: (x) => st.push(x), signal: new AbortController().signal });
    } finally {
      globalThis.fetch = realFetch;
      console.error = err;
    }
    const b = last(st);
    assert.ok(b.state === "failed");
    assert.equal(b.message, PAID_PLAN_MESSAGE, "same text when the plan request itself is refused");
  });
  test("with no code at all, nothing is sent", async () => {
    fakeWindow();
    saveLocation({ city: "Sebring", state: "FL" });
    const { statuses, seen } = await run();
    assert.equal(seen.length, 0);
    const s = last(statuses);
    assert.ok(s.state === "failed");
    assert.equal(s.message, TESTER_CODE_MESSAGE);
  });
});
