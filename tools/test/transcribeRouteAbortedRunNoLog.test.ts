/** POST /api/transcribe aborted-run log (2026-11-14): an aborted split
 * transcribe answers 500 (the client is gone, so the response is never
 * read) but logs no sightwork_run_failed — an abort is not a failure,
 * the same rule POST /api/plan applies. Without the guard a client
 * that walks away mid-narration counts as a failed run in the log
 * counter. Fake key + stubbed fetch only; no network, no key, no paid call. */
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

function post(body: string, signal?: AbortSignal): Request {
  return new Request("http://localhost/api/transcribe", {
    method: "POST",
    body,
    ...(signal ? { signal } : {}),
  });
}

/** sightwork_run_failed / sightwork_run_succeeded events from the captured console.log lines. */
function runEvents(logs: string[]): string[] {
  return logs
    .map((l) => {
      try {
        return JSON.parse(l) as { event?: string };
      } catch {
        return null;
      }
    })
    .filter(
      (o): o is { event: string } =>
        o?.event === "sightwork_run_failed" || o?.event === "sightwork_run_succeeded",
    )
    .map((o) => o.event);
}

/** Run fn with a dummy key set and fetch stubbed to hang until the
 * signal it was given aborts, then reject with an AbortError — the
 * shape a real fetch rejection takes mid-flight — while capturing
 * console.log lines. */
async function withAbortingFetch(
  fn: (state: { calls: () => number; seenSignal: () => unknown }, logs: string[]) => Promise<void>,
): Promise<void> {
  const prevKey = process.env.MODEL_API_KEY;
  const prevBilling = process.env.SIGHTWORK_BILLING;
  const prevFetch = globalThis.fetch;
  const prevLog = console.log;
  const prevError = console.error;
  const logs: string[] = [];
  let calls = 0;
  let seen: unknown;
  process.env.MODEL_API_KEY = "test-key";
  process.env.SIGHTWORK_BILLING = "";
  globalThis.fetch = ((...args: [unknown, { signal?: AbortSignal }?]) => {
    calls++;
    const init = args[1];
    seen = init?.signal;
    return new Promise((_resolve, reject) => {
      const err = new Error("asr: aborted");
      err.name = "AbortError";
      if (init?.signal?.aborted) {
        reject(err);
        return;
      }
      init?.signal?.addEventListener("abort", () => reject(err), { once: true });
    });
  }) as typeof fetch;
  console.log = (...args: unknown[]) => {
    logs.push(args.map((a) => String(a)).join(" "));
  };
  console.error = () => {};
  try {
    await fn({ calls: () => calls, seenSignal: () => seen }, logs);
  } finally {
    if (prevKey === undefined) delete process.env.MODEL_API_KEY;
    else process.env.MODEL_API_KEY = prevKey;
    if (prevBilling === undefined) delete process.env.SIGHTWORK_BILLING;
    else process.env.SIGHTWORK_BILLING = prevBilling;
    globalThis.fetch = prevFetch;
    console.log = prevLog;
    console.error = prevError;
  }
}

test("an aborted transcribe answers 500 and logs no run event", async () => {
  await withAbortingFetch(async (state, logs) => {
    const controller = new AbortController();
    const resPromise = POST(post(JSON.stringify({ audioWavBase64: wav() }), controller.signal));
    // Wait until the route has actually reached the ASR fetch, so the
    // abort below is mid-flight rather than before the call starts.
    for (let i = 0; i < 100 && state.calls() === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(state.calls(), 1);
    assert.ok(state.seenSignal() instanceof AbortSignal);
    controller.abort();
    assert.equal((state.seenSignal() as AbortSignal).aborted, true);
    const res = await resPromise;
    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), {
      error: "We couldn't transcribe that narration. Try again.",
      costUsd: 0,
    });
    assert.equal(state.calls(), 1);
    // No failed-run event (an abort is not a failure) and no
    // succeeded event either: the run ended with no terminal log event.
    assert.deepEqual(runEvents(logs), []);
  });
});
