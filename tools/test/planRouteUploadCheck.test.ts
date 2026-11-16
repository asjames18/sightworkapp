/** POST /api/plan uploading check (fff6438): a valid request streams plain uploading, then an uploading check with the frame count, before any step. Keyless, no network. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { POST } from "../../src/app/api/plan/route";
import { uploadCheck } from "../../src/lib/stepChecks";
import type { PlanJobStatus } from "../../src/lib/types";

const KEY_VARS = ["MODEL_API_KEY", "META_API_KEY", "BASETEN_API_KEY"];

function jpegDataUrl(bytes: number): string {
  const buf = Buffer.alloc(bytes);
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]).copy(buf, 0);
  return "data:image/jpeg;base64," + buf.toString("base64");
}

function body(frameCount: number): string {
  return JSON.stringify({
    durationSec: frameCount * 2,
    frames: Array.from({ length: frameCount }, (_, i) => ({ tSec: i * 2, dataUrl: jpegDataUrl(64) })),
  });
}

/** POST with every key unset and a fetch that throws if touched; returns the NDJSON lines and fetch call count. */
async function run(payload: string): Promise<{ lines: PlanJobStatus[]; fetches: number }> {
  const saved = Object.fromEntries(KEY_VARS.map((k) => [k, process.env[k]]));
  for (const k of KEY_VARS) delete process.env[k];
  const realFetch = globalThis.fetch;
  const realError = console.error;
  let fetches = 0;
  globalThis.fetch = (async () => {
    fetches++;
    throw new Error("fetch must not be called");
  }) as typeof fetch;
  console.error = () => {};
  try {
    const res = await POST(new Request("http://localhost/api/plan", { method: "POST", headers: { "Content-Type": "application/json" }, body: payload }));
    const text = await res.text();
    const lines = text.split("\n").filter(Boolean).map((l) => JSON.parse(l) as PlanJobStatus);
    return { lines, fetches };
  } finally {
    globalThis.fetch = realFetch;
    console.error = realError;
    for (const k of KEY_VARS) if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
}

for (const n of [1, 3, 12]) {
  test(`${n} frame(s): plain uploading, then the uploading check, then a keyless fail on uploading`, async () => {
    const { lines, fetches } = await run(body(n));
    assert.equal(fetches, 0);
    assert.deepEqual(lines[0], { state: "running", step: "uploading" });
    assert.deepEqual(lines[1], { state: "running", step: "uploading", check: uploadCheck(n) });
    assert.equal(lines.at(-1)?.state, "failed");
    assert.equal((lines.at(-1) as { step?: string }).step, "uploading");
    assert.equal(lines.filter((l) => "check" in l && l.check).length, 1, "exactly one check line");
  });
}

test("the check note is the frame count alone (no sharp swaps in the request)", async () => {
  const { lines } = await run(body(3));
  const check = (lines[1] as { check?: { ok: boolean; note: string } }).check;
  assert.deepEqual(check, uploadCheck(3, 0));
  assert.equal(check?.ok, true);
});

test("an invalid request gets one failed uploading line and no check", async () => {
  const { lines, fetches } = await run(JSON.stringify({ durationSec: 4, frames: [] }));
  assert.equal(fetches, 0);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].state, "failed");
  assert.ok(!("check" in lines[0]));
});
