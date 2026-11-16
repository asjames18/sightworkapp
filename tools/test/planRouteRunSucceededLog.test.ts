/** POST /api/plan finished-run log (2026-11-14): a run that ships a plan now also leaves a server-log trace (sightwork_run_succeeded, route + the spike total), the last terminal outcome without a countable event — refusals and failures already have one, and the done line is plain text only. A failed run or a refused request logs no event. No live calls: fetch is stubbed in-process and the keys are dummy values. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { POST } from "../../src/app/api/plan/route";
import type { PlanJobStatus, WorkPlan } from "../../src/lib/types";
import sanctuary from "../../src/lib/examples/sanctuary-run.json";

const S = sanctuary as unknown as WorkPlan;
const KEY_VARS = ["MODEL_API_KEY", "META_API_KEY", "BASETEN_API_KEY", "PLAN_PROVIDER"];
const ENV_VARS = [...KEY_VARS, "BASETEN_API_BASE_URL", "META_API_BASE_URL"];

/** Run-succeeded events from the captured console.log lines, in order. */
function runSucceeded(logs: string[]): { route?: string; costUsd?: number }[] {
  return logs
    .map((l) => {
      try {
        return JSON.parse(l) as { event?: string; route?: string; costUsd?: number };
      } catch {
        return null;
      }
    })
    .filter((o): o is { event: string; route: string; costUsd: number } =>
      o?.event === "sightwork_run_succeeded",
    );
}

/** Run-failed events from the captured console.log lines, in order. */
function runFailed(logs: string[]): { route?: string; step?: string; costUsd?: number }[] {
  return logs
    .map((l) => {
      try {
        return JSON.parse(l) as { event?: string; route?: string; step?: string; costUsd?: number };
      } catch {
        return null;
      }
    })
    .filter((o): o is { event: string; route: string; step: string; costUsd: number } =>
      o?.event === "sightwork_run_failed",
    );
}

/** Spike total from the plain-text "plan route: done" line, the same tracker total the event carries. */
function doneSpikeTotal(logs: string[]): number | undefined {
  for (const l of logs) {
    const m = /spike total \$([0-9.]+)/.exec(l);
    if (m) return Number(m[1]);
  }
  return undefined;
}

/** A tiny PCM WAV: 44-byte header plus a few silent samples (mono 16-bit 16 kHz). */
function wav(): string {
  const data = Buffer.alloc(32);
  const h = Buffer.alloc(44);
  h.write("RIFF", 0, "ascii");
  h.writeUInt32LE(36 + data.length, 4);
  h.write("WAVE", 8, "ascii");
  h.write("fmt ", 12, "ascii");
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(16000, 24);
  h.writeUInt32LE(32000, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36, "ascii");
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]).toString("base64");
}

function jpegDataUrl(): string {
  const buf = Buffer.alloc(64);
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]).copy(buf, 0);
  return "data:image/jpeg;base64," + buf.toString("base64");
}

function body(): string {
  return JSON.stringify({
    durationSec: 2,
    frames: [{ tSec: 0, dataUrl: jpegDataUrl() }],
    audioWavBase64: wav(),
  });
}

async function runLines(payload: string): Promise<PlanJobStatus[]> {
  const res = await POST(new Request("http://localhost/api/plan", { method: "POST", headers: { "Content-Type": "application/json" }, body: payload }));
  const text = await res.text();
  return text.split("\n").filter(Boolean).map((l) => JSON.parse(l) as PlanJobStatus);
}

async function withEnv(
  env: Record<string, string | undefined>,
  fetchImpl: typeof fetch,
  fn: (logs: string[]) => Promise<void>,
): Promise<void> {
  const saved = Object.fromEntries(KEY_VARS.map((k) => [k, process.env[k]]));
  for (const k of KEY_VARS) {
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
  process.env.SIGHTWORK_BILLING = "";
  const realFetch = globalThis.fetch;
  const realError = console.error;
  const realWarn = console.warn;
  const realLog = console.log;
  const logs: string[] = [];
  globalThis.fetch = fetchImpl;
  console.error = () => {};
  console.warn = () => {};
  console.log = (...args: unknown[]) => {
    logs.push(args.map((a) => String(a)).join(" "));
  };
  try {
    await fn(logs);
  } finally {
    globalThis.fetch = realFetch;
    console.error = realError;
    console.warn = realWarn;
    console.log = realLog;
    for (const k of KEY_VARS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    delete process.env.SIGHTWORK_BILLING;
  }
}

/** Reason-step answer for a finished plan: the stored sanctuary plan, as-is. */
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

/** Text of the single user message's text part(s) in a chat/completions body. */
function promptText(body: string): string {
  const parsed = JSON.parse(body) as { messages: { content: string | { type: string; text?: string }[] }[] };
  const content = parsed.messages[0].content;
  if (typeof content === "string") return content;
  return content.filter((p) => p.type === "text").map((p) => p.text ?? "").join("\n");
}

function completion(json: unknown): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { content: JSON.stringify(json) } }], usage: { prompt_tokens: 1000, completion_tokens: 500 } }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

test("a finished plan logs sightwork_run_succeeded with the route and the spike total", async () => {
  const saved = Object.fromEntries(ENV_VARS.map((k) => [k, process.env[k]]));
  for (const k of ENV_VARS) delete process.env[k];
  process.env.BASETEN_API_KEY = "dummy-key";
  process.env.MODEL_API_KEY = "dummy-key";
  process.env.SIGHTWORK_BILLING = "";
  const realFetch = globalThis.fetch;
  const realError = console.error;
  const realLog = console.log;
  const realWarn = console.warn;
  const logs: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith("https://inference.baseten.co/")) {
      const prompt = promptText(String(init?.body ?? ""));
      if (!/Photo A:/.test(prompt)) return completion(reasonJson());
      const ids = prompt
        .split("\n")
        .filter((l) => l.startsWith("id "))
        .map((l) => ({ id: l.split(" | ")[0].slice(3) }));
      return completion({
        ran: true,
        items: ids.map(({ id }) => ({ problemId: id, verified: true, reason: "The photo shows it." })),
      });
    }
    return new Response(JSON.stringify({ error: { message: "offline test" } }), { status: 400 });
  }) as typeof fetch;
  console.error = () => {};
  console.log = (...args: unknown[]) => {
    logs.push(args.map((a) => String(a)).join(" "));
  };
  console.warn = () => {};
  try {
    const payload = JSON.stringify({
      spaceName: S.spaceName,
      spaceType: "sanctuary",
      durationSec: 48,
      frames: (S.frames ?? []).map((f) => ({ tSec: f.tSec, dataUrl: jpegDataUrl() })),
      transcript: null,
      transcriptTurns: [],
    });
    const res = await POST(new Request("http://localhost/api/plan", { method: "POST", headers: { "Content-Type": "application/json" }, body: payload }));
    const lines = (await res.text())
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as PlanJobStatus);
    const last = lines.at(-1);
    assert.equal(last?.state, "done", `run ended ${JSON.stringify(last).slice(0, 300)}`);
    const events = runSucceeded(logs);
    assert.equal(events.length, 1);
    assert.equal(events[0].route, "plan");
    assert.equal(events[0].costUsd, doneSpikeTotal(logs));
    assert.deepEqual(runFailed(logs), []);
  } finally {
    globalThis.fetch = realFetch;
    console.error = realError;
    console.log = realLog;
    console.warn = realWarn;
    for (const k of ENV_VARS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    delete process.env.SIGHTWORK_BILLING;
  }
});

test("a failed run logs no sightwork_run_succeeded", async () => {
  // 42 s of audio at $0.18/hour: floor(42)/3600*0.18 = $0.0021.
  const stub = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/asr/")) {
      return new Response(
        JSON.stringify({
          sessionId: "test",
          transcript: "Fix the curtain",
          audioDurationMs: 42000,
          turns: [{ turnId: "t1", startMs: 0, endMs: 42000, transcript: "Fix the curtain" }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (url.includes("inference.baseten.co")) {
      return new Response("upstream error", { status: 500 });
    }
    return new Response(JSON.stringify({ error: { message: "unavailable" } }), { status: 400 });
  }) as typeof fetch;
  await withEnv(
    { MODEL_API_KEY: "dummy-key", META_API_KEY: "dummy-key", BASETEN_API_KEY: "dummy-key" },
    stub,
    async (logs) => {
      const lines = await runLines(body());
      const last = lines.at(-1);
      assert.equal(last?.state, "failed");
      assert.equal((last as { step?: string }).step, "comparing");
      assert.deepEqual(runSucceeded(logs), []);
      assert.equal(runFailed(logs).length, 1);
    },
  );
});

test("a refused request logs no sightwork_run_succeeded", async () => {
  const stub = (async () => {
    throw new Error("fetch must not be called");
  }) as typeof fetch;
  await withEnv(
    { MODEL_API_KEY: "dummy-key", META_API_KEY: "dummy-key", BASETEN_API_KEY: "dummy-key" },
    stub,
    async (logs) => {
      const lines = await runLines(JSON.stringify({}));
      const last = lines.at(-1);
      assert.equal(last?.state, "failed");
      assert.equal((last as { step?: string }).step, "uploading");
      assert.deepEqual(runSucceeded(logs), []);
    },
  );
});

test("an aborted plan logs no sightwork_run_succeeded", async () => {
  // Same abort shape as the failed-log abort test: stub fetch hangs
  // until the request signal aborts, then rejects with an AbortError,
  // and abort once the ASR call is in flight, so the abort lands
  // mid-run. The succeeded event is logged only after a run finishes
  // (after the done push), so an aborted run must log none — without
  // this, a client that walks away mid-plan would count as a
  // completed run in the log counter.
  let calls = 0;
  let seenSignal: unknown;
  const stub = ((input: string | URL | Request, init?: RequestInit) => {
    calls++;
    seenSignal = init?.signal;
    return new Promise((_resolve, reject) => {
      const err = new Error("asr: aborted");
      err.name = "AbortError";
      const signal = init?.signal;
      if (signal?.aborted) {
        reject(err);
        return;
      }
      signal?.addEventListener("abort", () => reject(err), { once: true });
    });
  }) as typeof fetch;
  await withEnv(
    { MODEL_API_KEY: "dummy-key", META_API_KEY: "dummy-key", BASETEN_API_KEY: "dummy-key" },
    stub,
    async (logs) => {
      const controller = new AbortController();
      const resPromise = POST(
        new Request("http://localhost/api/plan", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: body(),
          signal: controller.signal,
        }),
      );
      // Wait until the route has actually reached the ASR fetch, so the
      // abort below is mid-flight rather than before the call starts.
      for (let i = 0; i < 100 && calls === 0; i++) {
        await new Promise((r) => setTimeout(r, 10));
      }
      assert.equal(calls, 1);
      assert.ok(seenSignal instanceof AbortSignal);
      controller.abort();
      assert.equal((seenSignal as AbortSignal).aborted, true);
      const res = await resPromise;
      const lines = (await res.text())
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as PlanJobStatus);
      // The stream ends with the running lines only: no done line is
      // pushed for an abort, and no succeeded-run event is logged.
      assert.ok(lines.length > 0);
      assert.ok(lines.every((l) => l.state === "running"));
      assert.deepEqual(runSucceeded(logs), []);
      assert.deepEqual(runFailed(logs), []);
      assert.equal(calls, 1);
    },
  );
});
