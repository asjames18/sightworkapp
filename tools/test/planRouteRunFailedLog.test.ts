/** POST /api/plan failed-run log (2026-11-13): a run that dies mid-pipeline — a step failure after billed calls, or a wiring failure with no key — streams its failed line, and now also leaves a server-log trace (sightwork_run_failed, route + the failed step + the spike total, 0 when nothing billed), the same audit gap the refusal logs closed. A finished plan logs no event. No live calls: fetch is stubbed in-process and the keys are dummy values. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { POST } from "../../src/app/api/plan/route";
import type { PlanJobStatus, WorkPlan } from "../../src/lib/types";
import sanctuary from "../../src/lib/examples/sanctuary-run.json";

const S = sanctuary as unknown as WorkPlan;
const KEY_VARS = ["MODEL_API_KEY", "META_API_KEY", "BASETEN_API_KEY", "PLAN_PROVIDER"];
const ENV_VARS = [...KEY_VARS, "BASETEN_API_BASE_URL", "META_API_BASE_URL"];

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
  const res = await POST(new Request("http://localhost/api/plan", { method: "POST", body: payload }));
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

test("a billed step failure logs sightwork_run_failed with the failed step and the spend", async () => {
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
      assert.equal((last as { costUsd?: number }).costUsd, 0.0021);
      const events = runFailed(logs);
      assert.equal(events.length, 1);
      assert.equal(events[0].route, "plan");
      assert.equal(events[0].step, "comparing");
      assert.equal(events[0].costUsd, 0.0021);
    },
  );
});

test("a wiring failure logs sightwork_run_failed with step uploading and cost 0", async () => {
  const stub = (async () => {
    throw new Error("fetch must not be called");
  }) as typeof fetch;
  await withEnv({ MODEL_API_KEY: undefined, META_API_KEY: undefined, BASETEN_API_KEY: undefined }, stub, async (logs) => {
    const lines = await runLines(body());
    const last = lines.at(-1);
    assert.equal(last?.state, "failed");
    assert.equal((last as { step?: string }).step, "uploading");
    assert.ok(!("costUsd" in (last as object)));
    const events = runFailed(logs);
    assert.equal(events.length, 1);
    assert.equal(events[0].route, "plan");
    assert.equal(events[0].step, "uploading");
    assert.equal(events[0].costUsd, 0);
  });
});

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

test("a finished plan logs no sightwork_run_failed", async () => {
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
    const res = await POST(new Request("http://localhost/api/plan", { method: "POST", body: payload }));
    const lines = (await res.text())
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as PlanJobStatus);
    const last = lines.at(-1);
    assert.equal(last?.state, "done", `run ended ${JSON.stringify(last).slice(0, 300)}`);
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
