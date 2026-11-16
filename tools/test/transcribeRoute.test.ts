/** POST /api/transcribe body cap (10d4311): over 46 MB gets a 413 before JSON.parse and before any fetch. */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_TRANSCRIBE_BODY_BYTES,
  POST,
  transcribeBodyTooLarge,
} from "../../src/app/api/transcribe/route";

/** A valid no-narration JSON body padded with spaces to exactly `bytes` bytes. */
function paddedBody(bytes: number): string {
  const core = JSON.stringify({ audioWavBase64: "" });
  return core + " ".repeat(bytes - core.length);
}

function post(body: string): Request {
  return new Request("http://localhost/api/transcribe", { method: "POST", headers: { "Content-Type": "application/json" }, body });
}

/** Run fn with a fetch that throws if touched; returns how many times it was called. */
async function withNoFetch(fn: () => Promise<void>): Promise<number> {
  const real = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    throw new Error("fetch must not be called");
  }) as typeof fetch;
  try {
    await fn();
  } finally {
    globalThis.fetch = real;
  }
  return calls;
}

test("the cap is 46 MB", () => {
  assert.equal(MAX_TRANSCRIBE_BODY_BYTES, 46 * 1024 * 1024);
});

test("transcribeBodyTooLarge: exactly 46 MB passes, one byte more is too large", () => {
  assert.equal(transcribeBodyTooLarge("x".repeat(MAX_TRANSCRIBE_BODY_BYTES)), false);
  assert.equal(transcribeBodyTooLarge("x".repeat(MAX_TRANSCRIBE_BODY_BYTES + 1)), true);
});

test("transcribeBodyTooLarge counts UTF-8 bytes, not characters", () => {
  // "é" is 2 bytes in UTF-8: half the cap in characters is exactly the cap in bytes.
  const half = MAX_TRANSCRIBE_BODY_BYTES / 2;
  assert.equal(transcribeBodyTooLarge("é".repeat(half)), false);
  assert.equal(transcribeBodyTooLarge("é".repeat(half) + "x"), true);
});

test("POST: a body of 46 MB + 1 byte gets a 413 with zero fetches", async () => {
  const calls = await withNoFetch(async () => {
    const res = await POST(post(paddedBody(MAX_TRANSCRIBE_BODY_BYTES + 1)));
    assert.equal(res.status, 413);
    assert.deepEqual(await res.json(), { error: "transcribe request body too large" });
  });
  assert.equal(calls, 0);
});

test("POST: a no-narration body of exactly 46 MB passes the cap and returns the empty transcript", async () => {
  const calls = await withNoFetch(async () => {
    const res = await POST(post(paddedBody(MAX_TRANSCRIBE_BODY_BYTES)));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { transcript: null, transcriptTurns: [], costUsd: 0 });
  });
  assert.equal(calls, 0);
});

test("POST: malformed JSON under the cap is still a 400", async () => {
  const res = await POST(post("{not json"));
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: "could not read transcribe request" });
});
