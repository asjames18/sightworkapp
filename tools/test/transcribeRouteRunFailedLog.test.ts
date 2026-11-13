/** POST /api/transcribe failed-run log (2026-11-13): a transcribe that dies — the ASR call fails or fetch throws — answers 500, and now also leaves a server-log trace (sightwork_run_failed, route + the spike total, 0 when nothing billed), the same audit gap the refusal logs closed. A finished transcribe logs no event. No live calls: fetch is stubbed in-process and the keys are dummy values. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { POST } from "../../src/app/api/transcribe/route";

const KEY_VARS = ["MODEL_API_KEY", "META_API_KEY", "BASETEN_API_KEY"];

/** Run-failed events from the captured console.log lines, in order. */
function runFailed(logs: string[]): { route?: string; costUsd?: number }[] {
  return logs
    .map((l) => {
      try {
        return JSON.parse(l) as { event?: string; route?: string; costUsd?: number };
      } catch {
        return null;
      }
    })
    .filter((o): o is { event: string; route: string; costUsd: number } =>
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
  const savedBilling = process.env.SIGHTWORK_BILLING;
  process.env.SIGHTWORK_BILLING = "";
  const realFetch = globalThis.fetch;
  const realError = console.error;
  const realLog = console.log;
  const logs: string[] = [];
  globalThis.fetch = fetchImpl;
  console.error = () => {};
  console.log = (...args: unknown[]) => {
    logs.push(args.map((a) => String(a)).join(" "));
  };
  try {
    await fn(logs);
  } finally {
    globalThis.fetch = realFetch;
    console.error = realError;
    console.log = realLog;
    for (const k of KEY_VARS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    if (savedBilling === undefined) delete process.env.SIGHTWORK_BILLING;
    else process.env.SIGHTWORK_BILLING = savedBilling;
  }
}

function transcribeBody(): string {
  return JSON.stringify({ audioWavBase64: wav() });
}

test("a failed ASR call is 500 and logs sightwork_run_failed with the response cost", async () => {
  const stub = (async () => new Response("upstream error", { status: 500 })) as typeof fetch;
  await withEnv({ MODEL_API_KEY: "dummy-key" }, stub, async (logs) => {
    const res = await POST(
      new Request("http://localhost/api/transcribe", { method: "POST", body: transcribeBody() }),
    );
    assert.equal(res.status, 500);
    const body = (await res.json()) as { error?: string; costUsd?: number };
    assert.equal(body.error, "We couldn't transcribe that narration. Try again.");
    const events = runFailed(logs);
    assert.equal(events.length, 1);
    assert.equal(events[0].route, "transcribe");
    assert.equal(events[0].costUsd, body.costUsd);
  });
});

test("a thrown fetch is 500 and logs sightwork_run_failed with cost 0", async () => {
  const stub = (async () => {
    throw new Error("fetch must not be called");
  }) as typeof fetch;
  await withEnv({ MODEL_API_KEY: "dummy-key" }, stub, async (logs) => {
    const res = await POST(
      new Request("http://localhost/api/transcribe", { method: "POST", body: transcribeBody() }),
    );
    assert.equal(res.status, 500);
    const body = (await res.json()) as { error?: string; costUsd?: number };
    assert.equal(body.costUsd, 0);
    const events = runFailed(logs);
    assert.equal(events.length, 1);
    assert.equal(events[0].route, "transcribe");
    assert.equal(events[0].costUsd, 0);
  });
});

test("a finished transcribe logs no sightwork_run_failed", async () => {
  const stub = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    assert.ok(url.includes("/asr/"), `expected an ASR call, got ${url}`);
    return new Response(
      JSON.stringify({
        sessionId: "test",
        transcript: "Fix the curtain",
        audioDurationMs: 2000,
        turns: [{ turnId: "t1", startMs: 0, endMs: 2000, transcript: "Fix the curtain" }],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;
  await withEnv({ MODEL_API_KEY: "dummy-key" }, stub, async (logs) => {
    const res = await POST(
      new Request("http://localhost/api/transcribe", { method: "POST", body: transcribeBody() }),
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as { transcript?: string | null; costUsd?: number };
    assert.equal(body.transcript, "[0.0] Fix the curtain");
    assert.deepEqual(runFailed(logs), []);
  });
});
