/** POST /api/plan failed line carries costUsd (2026-10-31 12:15 PM):
 * types.ts now takes an optional costUsd on the failed PlanJobStatus
 * line (12:24 PM), so the route wires the tracker total onto
 * it. A run that bills ASR and then fails at the reason step streams a
 * failed comparing line with that spend; a run that bills nothing
 * streams a failed line with no costUsd, as before. No live calls:
 * fetch is stubbed in-process and the keys are dummy values. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { POST } from "../../src/app/api/plan/route";
import type { PlanJobStatus } from "../../src/lib/types";

const KEY_VARS = ["MODEL_API_KEY", "META_API_KEY", "BASETEN_API_KEY", "PLAN_PROVIDER"];

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
  fn: () => Promise<void>,
): Promise<void> {
  const saved = Object.fromEntries(KEY_VARS.map((k) => [k, process.env[k]]));
  for (const k of KEY_VARS) {
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
  const realFetch = globalThis.fetch;
  const realError = console.error;
  const realWarn = console.warn;
  const realLog = console.log;
  globalThis.fetch = fetchImpl;
  console.error = () => {};
  console.warn = () => {};
  console.log = () => {};
  try {
    await fn();
  } finally {
    globalThis.fetch = realFetch;
    console.error = realError;
    console.warn = realWarn;
    console.log = realLog;
    for (const k of KEY_VARS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

test("failed comparing line carries the ASR spend billed before the failure", async () => {
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
    { MODEL_API_KEY: "test-key", BASETEN_API_KEY: "test-key", PLAN_PROVIDER: "baseten" },
    stub,
    async () => {
      const lines = await runLines(body());
      const last = lines.at(-1);
      assert.equal(last?.state, "failed");
      assert.equal((last as { step?: string }).step, "comparing");
      assert.equal((last as { costUsd?: number }).costUsd, 0.0021);
    },
  );
});

test("a failed line with no billed calls carries no costUsd", async () => {
  const stub = (async () => {
    throw new Error("fetch must not be called");
  }) as typeof fetch;
  await withEnv({ MODEL_API_KEY: undefined, META_API_KEY: undefined, BASETEN_API_KEY: undefined }, stub, async () => {
    const lines = await runLines(body());
    const last = lines.at(-1);
    assert.equal(last?.state, "failed");
    assert.equal((last as { step?: string }).step, "uploading");
    assert.ok(!("costUsd" in (last as object)));
  });
});
