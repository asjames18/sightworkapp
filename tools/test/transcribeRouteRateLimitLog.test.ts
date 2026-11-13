/** POST /api/transcribe rate-limit log (2026-11-13): the per-IP brake refuses the 31st spending request in 10 minutes with 429; the refusal now leaves a server-log trace (sightwork_rate_limited, route + retryAfterSec, no IP), the same audit gap the entitlement-denial log closed. Keyless deploy, Meta ASR stubbed, billing off. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { POST } from "../../src/app/api/transcribe/route";
import { RATE_LIMIT_REQUESTS } from "../../src/lib/pipeline/rateLimit";

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

const wavBody = JSON.stringify({ audioWavBase64: wav() });

/** Rate-limit events from the captured console.log lines, in order. */
function rateLimited(logs: string[]): { route?: string; retryAfterSec?: number }[] {
  return logs
    .map((l) => {
      try {
        return JSON.parse(l) as { event?: string; route?: string; retryAfterSec?: number };
      } catch {
        return null;
      }
    })
    .filter((o): o is { event: string; route: string; retryAfterSec: number } =>
      o?.event === "sightwork_rate_limited",
    );
}

test("the 31st spending request is 429 and logs sightwork_rate_limited", async () => {
  const savedKey = process.env.MODEL_API_KEY;
  const savedBilling = process.env.SIGHTWORK_BILLING;
  process.env.MODEL_API_KEY = "test-meta-key";
  process.env.SIGHTWORK_BILLING = "";
  const realFetch = globalThis.fetch;
  const realError = console.error;
  const realLog = console.log;
  const logs: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith("https://api.meta.ai/v1/asr/transcribe")) {
      return new Response(
        JSON.stringify({
          audioDurationMs: 42000,
          turns: [{ startMs: 0, endMs: 2000, transcript: "hello there" }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;
  console.error = () => {};
  console.log = (...args: unknown[]) => {
    logs.push(args.map((a) => String(a)).join(" "));
  };
  try {
    // Fill the bucket: each allowed request transcribes (stubbed ASR)
    // and logs no rate-limit event.
    for (let i = 0; i < RATE_LIMIT_REQUESTS; i++) {
      const res = await POST(
        new Request("http://localhost/api/transcribe", { method: "POST", body: wavBody }),
      );
      assert.equal(res.status, 200);
      await res.json();
    }
    assert.deepEqual(rateLimited(logs), []);
    // One over the limit: 429 with Retry-After and exactly one log line.
    const res = await POST(
      new Request("http://localhost/api/transcribe", { method: "POST", body: wavBody }),
    );
    assert.equal(res.status, 429);
    assert.deepEqual(await res.json(), { error: "Too many transcribe requests. Try again shortly." });
    const retryAfter = res.headers.get("Retry-After");
    assert.ok(retryAfter !== null && Number(retryAfter) > 0);
    const events = rateLimited(logs);
    assert.equal(events.length, 1);
    assert.equal(events[0].route, "transcribe");
    assert.equal(events[0].retryAfterSec, Number(retryAfter));
  } finally {
    globalThis.fetch = realFetch;
    console.error = realError;
    console.log = realLog;
    if (savedKey === undefined) delete process.env.MODEL_API_KEY;
    else process.env.MODEL_API_KEY = savedKey;
    if (savedBilling === undefined) delete process.env.SIGHTWORK_BILLING;
    else process.env.SIGHTWORK_BILLING = savedBilling;
  }
});
