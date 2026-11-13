/**
 * runPlan picturing time-limit skip (2026-11-03: a live hosted run was cut at 312 s before
 * picturing, so no plan shipped): past ~230 s from the run start, picturing and reviewing are
 * skipped — no calls, no cost — and the plan still ships with meta.skipped.afterImage and a
 * ran:false review. A fresh run still pictures and reviews. Offline: every model caller is a stub
 * and fetch throws.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  runPlan,
  validateRunPlanDeps,
  PICTURING_TIME_LIMIT_MS,
  picturingTimeLimitExceeded,
  type RunPlanDeps,
} from "@/lib/pipeline/runPlan";
import { REASON_SCHEMA } from "@/lib/pipeline/planPrompts";
import { createUsageTracker, type UsageTracker } from "@/lib/pipeline/usage";
import { buildReviewPrompt } from "@/lib/reviewPrompt";
import type { PlanJobStatus, PlanRequest, WorkPlan } from "@/lib/types";
import sanctuary from "@/lib/examples/sanctuary-run.json";

const JPEG = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2w==";
const S = sanctuary as unknown as WorkPlan;

let realFetch: typeof fetch;
before(() => {
  realFetch = globalThis.fetch;
  globalThis.fetch = (() => {
    throw new Error("picturingTimeLimit.test: no network allowed");
  }) as typeof fetch;
});
after(() => {
  globalThis.fetch = realFetch;
});

const request: PlanRequest = {
  spaceName: S.spaceName,
  spaceType: "sanctuary",
  durationSec: 48,
  frames: (S.frames ?? []).map((f) => ({ tSec: f.tSec, dataUrl: JPEG })),
  transcript: null,
  transcriptTurns: [],
};

/** The stored real plan's reason fields, unchanged. */
function reasonJson(): unknown {
  return {
    spaceName: S.spaceName,
    generatedFrom: S.generatedFrom,
    inventory: S.inventory,
    issues: S.issues,
    materials: S.materials,
    workOrder: S.workOrder,
    transcriptSummary: null,
    saidVsSeen: [],
    heroFrameIndex: S.heroFrameIndex,
  };
}

async function run(startedAtMs?: number, picturingLimitMs?: number): Promise<{
  plan: WorkPlan;
  statuses: PlanJobStatus[];
  imageCalls: number;
  reviewCalls: number;
}> {
  const tracker = createUsageTracker();
  const statuses: PlanJobStatus[] = [];
  let imageCalls = 0;
  let reviewCalls = 0;
  const noCall = async () => {
    throw new Error("offline test: this caller must not run");
  };
  const deps: RunPlanDeps = {
    tracker,
    transcribe: { callTranscribe: noCall as never, tracker },
    segment: { callSegment: async () => ({ instances: [], latencyMs: 1, costUsd: 0 }), tracker },
    reason: { prompt: "offline", schema: REASON_SCHEMA, tracker, callSpark: async () => ({ json: reasonJson(), latencyMs: 1, costUsd: 0 }) },
    cost: { prompt: "unused", schema: {}, tracker, callSpark: noCall as never },
    renderAfter: {
      imageModel: "offline",
      tracker,
      callImage: (async () => {
        imageCalls += 1;
        return { images: [JPEG], latencyMs: 1, costUsd: 0 };
      }) as never,
    },
    review: {
      callSpark: (async () => {
        reviewCalls += 1;
        throw new Error("offline test: reviewer down");
      }) as never,
    },
    reviewPrompt: buildReviewPrompt,
    onStatus: (s) => statuses.push(s),
    ...(startedAtMs !== undefined ? { startedAtMs } : {}),
    ...(picturingLimitMs !== undefined ? { picturingLimitMs } : {}),
  };
  const plan = await runPlan(request, deps);
  return { plan, statuses, imageCalls, reviewCalls };
}

describe("picturing time-limit skip (offline)", () => {
  test("the limit is 230 s", () => {
    assert.equal(PICTURING_TIME_LIMIT_MS, 230_000);
  });

  test("one ms under the limit still pictures", () => {
    assert.equal(picturingTimeLimitExceeded(1000, 1000 + 230_000 - 1), false);
  });

  test("exactly at the limit skips", () => {
    assert.equal(picturingTimeLimitExceeded(1000, 1000 + 230_000), true);
  });

  test("past the limit (the 312 s live cut) skips", () => {
    assert.equal(picturingTimeLimitExceeded(1000, 1000 + 312_000), true);
  });

  test("a custom limit is honored, not the 230 s constant", () => {
    assert.equal(picturingTimeLimitExceeded(1000, 1000 + 59_999, 60_000), false);
    assert.equal(picturingTimeLimitExceeded(1000, 1000 + 60_000, 60_000), true);
    // The old code compared against the constant here, so a 60 s limit
    // would have kept picturing at 100 s in; now it skips.
    assert.equal(picturingTimeLimitExceeded(1000, 1000 + 100_000, 60_000), true);
    assert.equal(picturingTimeLimitExceeded(1000, 1000 + 230_000, 300_000), false);
  });

  test("an Infinity limit never exceeds", () => {
    assert.equal(picturingTimeLimitExceeded(1000, 1000 + 1_000_000, Infinity), false);
  });

  test("a stale run ships a plan with no image call, no review call, afterImage skipped, review not run", async () => {
    const { plan, statuses, imageCalls, reviewCalls } = await run(Date.now() - 240_000);
    assert.equal(imageCalls, 0, "no Image call on a stale run");
    assert.equal(reviewCalls, 0, "no review call on a stale run");
    assert.equal(plan.afterImageUrl, null);
    assert.equal(plan.meta?.skipped?.afterImage, true);
    assert.equal(plan.review?.ran, false);
    assert.ok(plan.issues.length > 0, "the plan itself still ships");
    assert.ok(!statuses.some((s) => s.state === "failed"));
  });

  test("a stale run with a short custom limit skips picturing even though it is under 230 s", async () => {
    const { plan, imageCalls, reviewCalls } = await run(Date.now() - 2_000, 1_000);
    assert.equal(imageCalls, 0, "no Image call under a 1 s limit at 2 s in");
    assert.equal(reviewCalls, 0, "no review call under a 1 s limit at 2 s in");
    assert.equal(plan.afterImageUrl, null);
    assert.equal(plan.meta?.skipped?.afterImage, true);
  });

  test("a stale run with an Infinity limit still pictures", async () => {
    const { plan, imageCalls, reviewCalls } = await run(Date.now() - 240_000, Infinity);
    assert.equal(imageCalls, 1, "one Image call with no limit");
    assert.equal(reviewCalls, 1, "one review call with no limit");
    assert.equal(plan.afterImageUrl, JPEG);
  });

  test("a fresh run still pictures and reviews", async () => {
    const { plan, statuses, imageCalls, reviewCalls } = await run();
    assert.equal(imageCalls, 1, "one Image call on a fresh run");
    assert.equal(reviewCalls, 1, "one review call on a fresh run");
    assert.equal(plan.afterImageUrl, JPEG);
    assert.equal(plan.meta?.skipped?.afterImage, undefined);
    assert.ok(!statuses.some((s) => s.state === "failed"));
  });

  test("a bad picturingLimitMs fails fast", () => {
    const base = {
      transcribe: {},
      segment: {},
      reason: {},
      cost: {},
      renderAfter: {},
      tracker: { record() {}, totals() {} },
    };
    assert.throws(
      () => validateRunPlanDeps({ ...base, picturingLimitMs: -1 } as unknown as RunPlanDeps),
      /picturingLimitMs must be a number/,
    );
    assert.throws(
      () => validateRunPlanDeps({ ...base, picturingLimitMs: Number.NaN } as unknown as RunPlanDeps),
      /picturingLimitMs must be a number/,
    );
    assert.doesNotThrow(
      () => validateRunPlanDeps({ ...base, picturingLimitMs: Infinity } as unknown as RunPlanDeps),
    );
    assert.doesNotThrow(
      () => validateRunPlanDeps({ ...base, picturingLimitMs: 0 } as unknown as RunPlanDeps),
    );
  });

  test("a bad startedAtMs fails fast", () => {
    const base = {
      transcribe: {},
      segment: {},
      reason: {},
      cost: {},
      renderAfter: {},
      tracker: { record() {}, totals() {} },
    };
    assert.throws(
      () => validateRunPlanDeps({ ...base, startedAtMs: -1 } as unknown as RunPlanDeps),
      /startedAtMs must be a finite number/,
    );
    assert.throws(
      () => validateRunPlanDeps({ ...base, startedAtMs: Number.NaN } as unknown as RunPlanDeps),
      /startedAtMs must be a finite number/,
    );
    assert.doesNotThrow(
      () => validateRunPlanDeps({ ...base, startedAtMs: 0 } as unknown as RunPlanDeps),
    );
  });
});
