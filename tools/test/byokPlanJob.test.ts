/**
 * Own-key browser runner: the key only goes to Meta, the pipeline is wired like the server's Meta mode,
 * failures never echo raw errors. Offline: fetch and the pipeline are stand-ins.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  createByokPlanJob,
  ownKeyDeps,
  KEY_REFUSED_MESSAGE,
  NO_KEY_MESSAGE,
  OWN_KEY_FAIL_MESSAGE,
  META_API_BASE_URL,
} from "@/lib/client/byokPlanJob";
import { LOCATION_REQUIRED_MESSAGE } from "@/lib/client/apiPlanJob";
import { PlanStepError } from "@/lib/pipeline/runPlan";
import type { PlanJobStatus, PlanRequest, WorkPlan } from "@/lib/types";

const KEY = "LLM_unitFakeKey_0123456789abcdefghij";
const file = { name: "walk.webm", type: "video/webm", size: 1 } as File;
const request: PlanRequest = { durationSec: 30, frames: [{ tSec: 1, dataUrl: "data:image/jpeg;base64,AAAA" }], audioWavBase64: "UklGRg==" };
const plan = { issues: [], steps: [], inventory: [] } as unknown as WorkPlan;

async function runWith(o: Partial<Parameters<typeof createByokPlanJob>[0]>, signal = new AbortController().signal) {
  const seen: PlanJobStatus[] = [];
  const job = createByokPlanJob({ buildRequest: async () => request, getKey: () => KEY, getRegion: () => "Sebring, FL", ...o });
  await job({ file, onStatus: (s) => seen.push(s), signal });
  return seen;
}

describe("own-key runner", () => {
  test("no key or no city: stops on uploading before reading the video", async () => {
    let built = 0;
    const noKey = await runWith({ getKey: () => "", buildRequest: async () => { built++; return request; } });
    assert.equal(noKey.at(-1)?.state === "failed" && noKey.at(-1)?.state === "failed" && (noKey.at(-1) as { message: string }).message, NO_KEY_MESSAGE);
    const noCity = await runWith({ getRegion: () => "", buildRequest: async () => { built++; return request; } });
    assert.equal((noCity.at(-1) as { message: string }).message, LOCATION_REQUIRED_MESSAGE);
    assert.equal(built, 0);
  });

  test("a finished run ends on the plan with the region; region and key-free request reach the pipeline", async () => {
    let got: PlanRequest | null = null;
    let gotDeps: unknown = null;
    const seen = await runWith({ canTranscribe: () => true, run: async (r, d) => { got = r; gotDeps = d; return plan; } });
    assert.equal(seen.at(-1)?.state, "done");
    assert.equal((got as unknown as PlanRequest).region, "Sebring, FL");
    assert.equal((got as unknown as PlanRequest).audioWavBase64, "UklGRg==");
    assert.ok(!JSON.stringify(got).includes(KEY));
    assert.equal((gotDeps as { planProvider: string }).planProvider, "meta");
  });

  test("without browser transcription, the narration is left out instead of failing the run", async () => {
    let got: PlanRequest | null = null;
    await runWith({ canTranscribe: () => false, run: async (r) => { got = r; return plan; } });
    assert.equal((got as unknown as PlanRequest).audioWavBase64, undefined);
  });

  test("a step error shows its own message; anything else gets a generic line, never the raw error", async () => {
    const step = await runWith({ run: async () => { throw new PlanStepError("planning", "Building the work plan failed. Try again.", "provider said xyz"); } });
    assert.equal((step.at(-1) as { message: string }).message, "Building the work plan failed. Try again.");
    const odd = await runWith({ run: async () => { throw new Error(`boom ${KEY} provider body`); } });
    const msg = (odd.at(-1) as { message: string }).message;
    assert.equal(msg, OWN_KEY_FAIL_MESSAGE);
    assert.ok(!JSON.stringify(odd).includes(KEY));
  });

  test("a 401 or 403 from Meta says the key wasn't accepted", async () => {
    const seen = await runWith({ run: async () => { throw new PlanStepError("looking", "Looking failed.", "meta 401 unauthorized"); } });
    assert.equal((seen.at(-1) as { message: string }).message, KEY_REFUSED_MESSAGE);
  });

  test("a stopped run reports nothing more", async () => {
    const ac = new AbortController();
    const seen = await runWith({ run: async () => { ac.abort(); const e = new Error("stop"); e.name = "AbortError"; throw e; } }, ac.signal);
    assert.ok(seen.every((s) => s.state === "running"));
  });

  test("the callers send the key only to Meta's API, as a Bearer header", async () => {
    const calls: { url: string; auth: string | null }[] = [];
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), auth: new Headers(init?.headers).get("authorization") });
      return new Response(JSON.stringify({ error: "nope" }), { status: 401, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
    const deps = ownKeyDeps(KEY, fakeFetch);
    await deps.cost.callSpark({ model: "test-model", prompt: "x", schema: {} } as never).catch(() => undefined);
    assert.ok(calls.length >= 1);
    for (const c of calls) {
      assert.ok(c.url.startsWith(META_API_BASE_URL), c.url);
      assert.equal(c.auth, `Bearer ${KEY}`);
    }
  });
});
