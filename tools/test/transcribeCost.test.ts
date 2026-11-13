import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { failureCostUsd, parseTranscribeAnswer, splitNarration, withTranscribeCost } from "@/lib/client/apiPlanJob";
import type { PlanRequest } from "@/lib/types";
import type { WorkPlan } from "@/lib/types";

const plan = (meta?: WorkPlan["meta"]) => ({ issues: [], ...(meta ? { meta } : {}) }) as unknown as WorkPlan;

describe("transcribe answer cost", () => {
  test("a real cost is kept", () => {
    assert.equal(parseTranscribeAnswer({ transcript: "[0] hi", transcriptTurns: [{ startSec: 0, text: "hi" }], costUsd: 0.031 })?.costUsd, 0.031);
  });
  test("missing, zero, negative, NaN, Infinity or text cost reads as 0", () => {
    for (const costUsd of [undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY, "0.5"])
      assert.equal(parseTranscribeAnswer({ transcript: null, transcriptTurns: [], costUsd })?.costUsd, 0, String(costUsd));
  });
});

describe("withTranscribeCost", () => {
  test("adds to the plan's total without float noise", () => {
    assert.equal(withTranscribeCost(plan({ costUsd: 0.1 }), 0.2).meta?.costUsd, 0.3);
  });
  test("keeps the rest of meta", () => {
    const out = withTranscribeCost(plan({ costUsd: 0.5, region: "Atlanta, GA" }), 0.05);
    assert.deepEqual(out.meta, { costUsd: 0.55, region: "Atlanta, GA" });
  });
  test("a zero plan total still gains the transcribe cost", () => {
    assert.equal(withTranscribeCost(plan({ costUsd: 0 }), 0.02).meta?.costUsd, 0.02);
  });
  test("no plan total, or a bad one, is left alone", () => {
    for (const p of [plan(), plan({}), plan({ costUsd: Number.NaN }), plan({ costUsd: -1 })]) {
      const out = withTranscribeCost(p, 0.04);
      assert.equal(out, p);
    }
  });
  test("no transcribe cost returns the same plan", () => {
    const p = plan({ costUsd: 0.4 });
    for (const t of [0, -0.1, Number.NaN, Number.POSITIVE_INFINITY]) assert.equal(withTranscribeCost(p, t), p);
  });
});

describe("failed transcribe request cost", () => {
  test("failureCostUsd reads a real costUsd and nothing else", () => {
    assert.equal(failureCostUsd({ error: "x", costUsd: 0.0021 }), 0.0021);
    for (const v of [null, "text", 5, {}, { costUsd: 0 }, { costUsd: -1 }, { costUsd: Number.NaN }, { costUsd: "0.1" }])
      assert.equal(failureCostUsd(v), 0, JSON.stringify(v));
  });

  const body = { audioWavBase64: "UklGRg==", frames: [] } as unknown as PlanRequest;
  const withFetch = async (res: () => Response, run: () => Promise<void>) => {
    const real = globalThis.fetch;
    const warn = console.warn;
    globalThis.fetch = (async () => res()) as typeof fetch;
    console.warn = () => {};
    try {
      await run();
    } finally {
      globalThis.fetch = real;
      console.warn = warn;
    }
  };

  test("a 500 that carries costUsd keeps the audio request and returns that cost", async () => {
    await withFetch(
      () => new Response(JSON.stringify({ error: "Transcription failed", costUsd: 0.0021 }), { status: 500 }),
      async () => {
        const out = await splitNarration(body, "/api/transcribe", "code", new AbortController().signal);
        assert.notEqual(out, "unauthorized");
        if (typeof out === "string") return assert.fail(out);
        assert.equal(out.body, body);
        assert.equal(out.costUsd, 0.0021);
      },
    );
  });

  test("a 500 with no cost, a bad cost or a plain-text body adds nothing", async () => {
    for (const text of [JSON.stringify({ error: "x" }), JSON.stringify({ error: "x", costUsd: 0 }), "Internal Server Error"]) {
      await withFetch(
        () => new Response(text, { status: 500 }),
        async () => {
          const out = await splitNarration(body, "/api/transcribe", "code", new AbortController().signal);
          if (typeof out === "string") return assert.fail(`unexpected ${out}`);
          assert.equal(out.body, body);
          assert.equal(out.costUsd, 0, text);
        },
      );
    }
  });

  test("a 401 is still unauthorized", async () => {
    await withFetch(
      () => new Response(JSON.stringify({ error: "no", costUsd: 0.5 }), { status: 401 }),
      async () => assert.equal(await splitNarration(body, "/api/transcribe", "code", new AbortController().signal), "unauthorized"),
    );
  });
});
