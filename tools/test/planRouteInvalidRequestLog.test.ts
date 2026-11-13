/** POST /api/plan invalid-request log (2026-11-13): a body that fails validation is refused with a failed uploading line; the refusal now leaves a server-log trace (sightwork_invalid_request, route + problem count, never the request content), the same audit gap the entitlement-denial, rate-limit, body-too-large and unreadable-body logs closed. Keyless, billing off. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { POST } from "../../src/app/api/plan/route";
import type { PlanJobStatus } from "../../src/lib/types";

const KEY_VARS = ["MODEL_API_KEY", "META_API_KEY", "BASETEN_API_KEY"];

/** Invalid-request events from the captured console.log lines, in order. */
function invalidRequest(logs: string[]): { route?: string; problems?: number }[] {
  return logs
    .map((l) => {
      try {
        return JSON.parse(l) as { event?: string; route?: string; problems?: number };
      } catch {
        return null;
      }
    })
    .filter(
      (o): o is { event: string; route: string; problems: number } =>
        o?.event === "sightwork_invalid_request",
    );
}

function jpegDataUrl(bytes: number): string {
  const buf = Buffer.alloc(bytes);
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]).copy(buf, 0);
  return "data:image/jpeg;base64," + buf.toString("base64");
}

test("an invalid plan body fails and logs sightwork_invalid_request with its problem count", async () => {
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
    const res = await POST(
      new Request("http://localhost/api/plan", {
        method: "POST",
        body: JSON.stringify({ durationSec: 2, frames: [] }),
      }),
    );
    assert.equal(res.status, 200);
    const lines = (await res.text())
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as PlanJobStatus);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].state, "failed");
    assert.equal(lines[0].step, "uploading");
    const events = invalidRequest(logs);
    assert.equal(events.length, 1);
    assert.equal(events[0].route, "plan");
    assert.equal(events[0].problems, 1);
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

test("a plan body with two problems logs problems 2", async () => {
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
    const res = await POST(
      new Request("http://localhost/api/plan", { method: "POST", body: JSON.stringify({}) }),
    );
    assert.equal(res.status, 200);
    const lines = (await res.text())
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as PlanJobStatus);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].state, "failed");
    assert.equal(lines[0].step, "uploading");
    const events = invalidRequest(logs);
    assert.equal(events.length, 1);
    assert.equal(events[0].route, "plan");
    assert.equal(events[0].problems, 2);
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

test("a valid plan body logs no sightwork_invalid_request", async () => {
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
    assert.deepEqual(invalidRequest(logs), []);
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
