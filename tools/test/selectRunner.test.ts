/**
 * Own-video runner choice: a video the user recorded or chose must never end on the example plan unless
 * an example-plan preview was asked for on purpose. Offline: no network, no model calls.
 */
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { ownVideoRunnerKind, needsTesterCode, planJobFor, pickRunnerKind, hasOwnKeyHere } from "@/lib/client/selectRunner";
import { byokPlanJob, BYOK_NOT_READY_MESSAGE } from "@/lib/client/byokPlanJob";
import { mockPlanJob } from "@/lib/client/planJob";
import { messageForStatus, TESTER_CODE_MESSAGE, WRONG_CODE_MESSAGE, isTesterCodeFailure, createApiPlanJob } from "@/lib/client/apiPlanJob";
import { EXAMPLES } from "@/lib/examples";
import type { PlanJobStatus } from "@/lib/types";
import { fakeWindow, noWindow } from "./browser-stubs";

afterEach(noWindow);

const recorded = { name: "sightwork-walkthrough.webm", type: "video/webm", size: 1 } as File;
const chosen = { name: "IMG_0412.MOV", type: "video/quicktime", size: 1 } as File;

describe("own video runner", () => {
  test("public site (env unset), plain /start: a real run, not the example plan", () => {
    assert.equal(ownVideoRunnerKind(null, undefined), "api");
    assert.equal(ownVideoRunnerKind("", undefined), "api");
    assert.equal(ownVideoRunnerKind("", ""), "api");
    // The upload screen's own mode still reads mock here: the tester code form isn't shown up front.
    assert.equal(pickRunnerKind("", undefined), "mock");
  });
  test("unrelated query keys don't switch on the preview", () => {
    assert.equal(ownVideoRunnerKind("?view=last", undefined), "api");
    assert.equal(ownVideoRunnerKind("?utm_source=x&plan=baseten", undefined), "api");
  });
  test("?runner wins over everything", () => {
    assert.equal(ownVideoRunnerKind("?runner=api", "mock"), "api");
    assert.equal(ownVideoRunnerKind("?runner=api&fail=planning", undefined), "api");
    assert.equal(ownVideoRunnerKind("?runner=mock", undefined), "mock");
    assert.equal(ownVideoRunnerKind("?runner=mock", "api"), "mock");
  });
  test("the example preview only when asked for: ?fail=, ?mock=, or an explicit mock build", () => {
    assert.equal(ownVideoRunnerKind("?fail=planning", undefined), "mock");
    assert.equal(ownVideoRunnerKind("?mock=nometa", undefined), "mock");
    assert.equal(ownVideoRunnerKind("", "mock"), "mock");
    assert.equal(ownVideoRunnerKind("", " Mock "), "mock");
    assert.equal(ownVideoRunnerKind("", "api"), "api");
    assert.equal(ownVideoRunnerKind("?runner=nope", "nope"), "api");
  });
  test("a real run without a saved code asks for it first; the preview never does", () => {
    assert.equal(needsTesterCode("api", ""), true);
    assert.equal(needsTesterCode("api", "   "), true);
    assert.equal(needsTesterCode("api", "abc"), false);
    assert.equal(needsTesterCode("mock", ""), false);
  });
  test("runners are stable per kind, so a run only restarts on a new video or retry", () => {
    assert.equal(planJobFor("mock"), mockPlanJob);
    assert.equal(planJobFor("api"), planJobFor("api"));
    assert.notEqual(planJobFor("api"), mockPlanJob);
  });
  test("the 401 text is the one the flow matches to reopen the code prompt", () => {
    assert.equal(messageForStatus(401), TESTER_CODE_MESSAGE);
    assert.match(TESTER_CODE_MESSAGE, /tester code/);
    assert.ok(isTesterCodeFailure(TESTER_CODE_MESSAGE));
    assert.ok(isTesterCodeFailure(WRONG_CODE_MESSAGE));
    assert.ok(!isTesterCodeFailure("The plan took too long to finish."));
  });
  test("a saved code the server refuses says so plainly, not a generic failure", async () => {
    fakeWindow("?runner=api");
    window.localStorage.setItem("sightwork:test-code", "not-the-code");
    window.localStorage.setItem("sightwork:location", JSON.stringify({ city: "Sebring", state: "FL" }));
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: "x" }), { status: 401 })) as typeof fetch;
    try {
      const statuses: PlanJobStatus[] = [];
      const req = { frames: [], audio: null } as unknown as import("@/lib/types").PlanRequest;
      await createApiPlanJob(async () => req)({ file: chosen, onStatus: (s) => statuses.push(s), signal: new AbortController().signal });
      const last = statuses.at(-1);
      assert.equal(last?.state, "failed");
      if (last?.state === "failed") assert.equal(last.message, WRONG_CODE_MESSAGE);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("why the bug happened: the preview runner ignores the video", () => {
  // Recorded and chosen videos both reach the runner the same way (UploadStep's pick, then the card's button),
  // and the preview runner never reads the file: it always ends on an example plan.
  for (const [label, file] of [["recorded", recorded], ["chosen", chosen]] as const) {
    test(`${label} video through the preview runner ends on an example plan`, async () => {
      fakeWindow("?runner=mock");
      const statuses: PlanJobStatus[] = [];
      // A real timer walk is ~5 s; abort-free, just wait for the end.
      await mockPlanJob({ file, onStatus: (s) => statuses.push(s), signal: new AbortController().signal });
      const last = statuses.at(-1);
      assert.equal(last?.state, "done");
      if (last?.state === "done") assert.ok(EXAMPLES.some((e) => e.plan.spaceName === last.plan.spaceName && e.plan.generatedFrom === last.plan.generatedFrom));
    });
  }
  for (const [label, file] of [["recorded", recorded], ["chosen", chosen]] as const) {
    test(`${label} video on the public site goes to the real runner; with no code it stops at once with the code message`, async () => {
      fakeWindow("");
      const kind = ownVideoRunnerKind("", undefined);
      assert.equal(kind, "api");
      const calls: string[] = [];
      const realFetch = globalThis.fetch;
      globalThis.fetch = (async (u: string) => {
        calls.push(String(u));
        throw new Error("no network in tests");
      }) as typeof fetch;
      try {
        const statuses: PlanJobStatus[] = [];
        await planJobFor(kind)({ file, onStatus: (s) => statuses.push(s), signal: new AbortController().signal });
        const last = statuses.at(-1);
        assert.equal(last?.state, "failed");
        if (last?.state === "failed") assert.equal(last.message, TESTER_CODE_MESSAGE);
        assert.ok(!statuses.some((s) => s.state === "done"), "never an example plan");
        assert.deepEqual(calls, [], "nothing sent without a code");
      } finally {
        globalThis.fetch = realFetch;
      }
    });
  }
});

describe("own-key runner", () => {
  test("a saved key with own-key mode on sends the user's video to the own-key runner", () => {
    assert.equal(ownVideoRunnerKind("", undefined, true), "own");
    assert.equal(ownVideoRunnerKind("", "mock", true), "own");
    assert.equal(ownVideoRunnerKind("", "api", true), "own");
  });
  test("no key keeps today's choice", () => {
    assert.equal(ownVideoRunnerKind("", undefined, false), "api");
    assert.equal(ownVideoRunnerKind("", "mock", false), "mock");
  });
  test("query switches still win, so previews and forced server runs keep working", () => {
    assert.equal(ownVideoRunnerKind("?runner=api", undefined, true), "api");
    assert.equal(ownVideoRunnerKind("?runner=mock", undefined, true), "mock");
    assert.equal(ownVideoRunnerKind("?fail=planning", undefined, true), "mock");
    assert.equal(ownVideoRunnerKind("?mock=nometa", undefined, true), "mock");
  });
  test("an own-key run never asks for the tester code", () => {
    assert.equal(needsTesterCode("own", ""), false);
  });
  test("the own-key runner is its own stable runner", () => {
    assert.equal(planJobFor("own"), byokPlanJob);
    assert.equal(planJobFor("own", true), byokPlanJob);
    assert.notEqual(planJobFor("own"), mockPlanJob);
    assert.notEqual(planJobFor("own"), planJobFor("api"));
  });
  test("until the browser runner lands, it stops at once with a plain message and spends nothing", async () => {
    const seen: PlanJobStatus[] = [];
    const realFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => { calls++; throw new Error("no network in this test"); }) as typeof fetch;
    try {
      await byokPlanJob({ file: recorded, onStatus: (s) => seen.push(s), signal: new AbortController().signal });
    } finally {
      globalThis.fetch = realFetch;
    }
    assert.equal(calls, 0);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].state, "failed");
    assert.equal(seen[0].state === "failed" && seen[0].message, BYOK_NOT_READY_MESSAGE);
    assert.match(BYOK_NOT_READY_MESSAGE, /Nothing was sent anywhere/);
  });
  test("an aborted run reports nothing", async () => {
    const seen: PlanJobStatus[] = [];
    const ac = new AbortController();
    ac.abort();
    await byokPlanJob({ file: chosen, onStatus: (s) => seen.push(s), signal: ac.signal });
    assert.equal(seen.length, 0);
  });
  test("hasOwnKeyHere is false on the server and when own-key mode is off", () => {
    assert.equal(hasOwnKeyHere(), false);
    const prev = process.env.NEXT_PUBLIC_SIGHTWORK_BYOK;
    try {
      delete process.env.NEXT_PUBLIC_SIGHTWORK_BYOK;
      fakeWindow("");
      assert.equal(hasOwnKeyHere(), false);
    } finally {
      if (prev === undefined) delete process.env.NEXT_PUBLIC_SIGHTWORK_BYOK; else process.env.NEXT_PUBLIC_SIGHTWORK_BYOK = prev;
    }
  });
});
