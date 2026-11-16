/** POST /api/transcribe failure path carries costUsd (2026-10-31 10:45 AM):
 * the success path returns the tracker total, but the 500 used to return
 * only { error }, so a billed ASR failure recorded by the transcribe step
 * was invisible to the split caller except in the server log. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { POST } from "../../src/app/api/transcribe/route";

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

function post(body: string): Request {
  return new Request("http://localhost/api/transcribe", { method: "POST", headers: { "Content-Type": "application/json" }, body });
}

/** Run fn with a dummy key set and fetch stubbed to answer `json` with a 200. */
async function withStubbedAsr(json: unknown, fn: () => Promise<void>): Promise<void> {
  const prevKey = process.env.MODEL_API_KEY;
  const prevFetch = globalThis.fetch;
  process.env.MODEL_API_KEY = "test-key";
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(json), { status: 200, headers: { "Content-Type": "application/json" } })) as typeof fetch;
  try {
    await fn();
  } finally {
    if (prevKey === undefined) delete process.env.MODEL_API_KEY;
    else process.env.MODEL_API_KEY = prevKey;
    globalThis.fetch = prevFetch;
  }
}

test("POST: a billed ASR parse failure returns 500 with the recorded cost", async () => {
  // 42 s of audio at $0.18/hour: floor(42)/3600*0.18 = $0.0021.
  await withStubbedAsr({ audioDurationMs: 42000, turns: "not-an-array" }, async () => {
    const res = await POST(post(JSON.stringify({ audioWavBase64: wav() })));
    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), {
      error: "We couldn't transcribe that narration. Try again.",
      costUsd: 0.0021,
    });
  });
});

test("POST: an unpriceable ASR parse failure returns 500 with costUsd 0", async () => {
  await withStubbedAsr({ turns: "not-an-array" }, async () => {
    const res = await POST(post(JSON.stringify({ audioWavBase64: wav() })));
    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), {
      error: "We couldn't transcribe that narration. Try again.",
      costUsd: 0,
    });
  });
});
