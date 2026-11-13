/** POST /api/plan rate-limit log (2026-11-13): the per-IP brake refuses the 31st spending request in 10 minutes with 429; the refusal now leaves a server-log trace (sightwork_rate_limited, route + retryAfterSec, no IP), the same audit gap the entitlement-denial log closed. Keyless, billing off. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { POST } from "../../src/app/api/plan/route";
import { RATE_LIMIT_REQUESTS } from "../../src/lib/pipeline/rateLimit";
import type { PlanJobStatus } from "../../src/lib/types";

const KEY_VARS = ["MODEL_API_KEY", "META_API_KEY", "BASETEN_API_KEY"];

function jpegDataUrl(bytes: number): string {
  const buf = Buffer.alloc(bytes);
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]).copy(buf, 0);
  return "data:image/jpeg;base64," + buf.toString("base64");
}

function body(): string {
  return JSON.stringify({
    durationSec: 2,
    frames: [{ tSec: 0, dataUrl: jpegDataUrl(64) }],
  });
}

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
  const saved = Object.fromEntries(KEY_VARS.map((k) => [k, process.env[k]]));
  for (const k of KEY_VARS) delete process.env[k];
  process.env.SIGHTWORK_BILLING = "";
  const realError = console.error;
  const realLog = console.log;
  const logs: string[] = [];
  console.error = () => {};
  console.log = (...args: unknown[]) => {
    logs.push(args.map((a) => String(a)).join(" "));
  };
  try {
    // Fill the bucket: each allowed request streams a failed line
    // (no key, so wiring fails fast) and logs no rate-limit event.
    for (let i = 0; i < RATE_LIMIT_REQUESTS; i++) {
      const res = await POST(
        new Request("http://localhost/api/plan", { method: "POST", body: body() }),
      );
      assert.equal(res.status, 200);
      await res.text();
    }
    assert.deepEqual(rateLimited(logs), []);
    // One over the limit: 429 with Retry-After and exactly one log line.
    const res = await POST(
      new Request("http://localhost/api/plan", { method: "POST", body: body() }),
    );
    assert.equal(res.status, 429);
    assert.deepEqual(await res.json(), { error: "Too many plan requests. Try again shortly." });
    const retryAfter = res.headers.get("Retry-After");
    assert.ok(retryAfter !== null && Number(retryAfter) > 0);
    const events = rateLimited(logs);
    assert.equal(events.length, 1);
    assert.equal(events[0].route, "plan");
    assert.equal(events[0].retryAfterSec, Number(retryAfter));
  } finally {
    console.error = realError;
    console.log = realLog;
    for (const k of KEY_VARS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    delete process.env.SIGHTWORK_BILLING;
  }
});
