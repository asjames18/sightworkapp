/** POST /api/plan body-too-large log (2026-11-13): a body over the 10 MB route cap is refused with 413; the refusal now leaves a server-log trace (sightwork_body_too_large, route + bytes, never the body), the same audit gap the entitlement-denial and rate-limit logs closed. Keyless, billing off. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { POST } from "../../src/app/api/plan/route";
import { MAX_PLAN_BODY_BYTES } from "../../src/lib/pipeline/planRequest";

const KEY_VARS = ["MODEL_API_KEY", "META_API_KEY", "BASETEN_API_KEY"];

/** Body-too-large events from the captured console.log lines, in order. */
function bodyTooLarge(logs: string[]): { route?: string; bytes?: number }[] {
  return logs
    .map((l) => {
      try {
        return JSON.parse(l) as { event?: string; route?: string; bytes?: number };
      } catch {
        return null;
      }
    })
    .filter((o): o is { event: string; route: string; bytes: number } =>
      o?.event === "sightwork_body_too_large",
    );
}

function jpegDataUrl(bytes: number): string {
  const buf = Buffer.alloc(bytes);
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]).copy(buf, 0);
  return "data:image/jpeg;base64," + buf.toString("base64");
}

test("an oversize plan body is 413 and logs sightwork_body_too_large", async () => {
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
    const body = "x".repeat(MAX_PLAN_BODY_BYTES + 1);
    const res = await POST(
      new Request("http://localhost/api/plan", { method: "POST", body }),
    );
    assert.equal(res.status, 413);
    assert.deepEqual(await res.json(), { error: "plan request body too large" });
    const events = bodyTooLarge(logs);
    assert.equal(events.length, 1);
    assert.equal(events[0].route, "plan");
    assert.equal(events[0].bytes, new TextEncoder().encode(body).length);
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

test("a normal plan body logs no sightwork_body_too_large", async () => {
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
    const body = JSON.stringify({
      durationSec: 2,
      frames: [{ tSec: 0, dataUrl: jpegDataUrl(64) }],
    });
    const res = await POST(
      new Request("http://localhost/api/plan", { method: "POST", body }),
    );
    assert.equal(res.status, 200);
    await res.text();
    assert.deepEqual(bodyTooLarge(logs), []);
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
