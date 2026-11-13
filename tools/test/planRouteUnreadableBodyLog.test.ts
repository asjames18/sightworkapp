/** POST /api/plan unreadable-body log (2026-11-13): a body that cannot be read or is not JSON is refused (400, or a failed uploading line); the refusal now leaves a server-log trace (sightwork_unreadable_body, route only, never the body), the same audit gap the entitlement-denial, rate-limit and body-too-large logs closed. Keyless, billing off. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { POST } from "../../src/app/api/plan/route";
import type { PlanJobStatus } from "../../src/lib/types";

const KEY_VARS = ["MODEL_API_KEY", "META_API_KEY", "BASETEN_API_KEY"];

/** Unreadable-body events from the captured console.log lines, in order. */
function unreadableBody(logs: string[]): { route?: string }[] {
  return logs
    .map((l) => {
      try {
        return JSON.parse(l) as { event?: string; route?: string };
      } catch {
        return null;
      }
    })
    .filter((o): o is { event: string; route: string } => o?.event === "sightwork_unreadable_body");
}

function jpegDataUrl(bytes: number): string {
  const buf = Buffer.alloc(bytes);
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]).copy(buf, 0);
  return "data:image/jpeg;base64," + buf.toString("base64");
}

test("a non-JSON plan body fails and logs sightwork_unreadable_body", async () => {
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
      new Request("http://localhost/api/plan", { method: "POST", body: "{not json" }),
    );
    assert.equal(res.status, 200);
    const lines = (await res.text())
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as PlanJobStatus);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].state, "failed");
    assert.equal(lines[0].step, "uploading");
    const events = unreadableBody(logs);
    assert.equal(events.length, 1);
    assert.equal(events[0].route, "plan");
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

test("an unreadable plan body is 400 and logs sightwork_unreadable_body", async () => {
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
    const stream = new ReadableStream({ start(c) { c.error(new Error("boom")); } });
    // duplex is not in this TS lib's RequestInit, so the cast stands in for it.
    const init = { method: "POST", body: stream, duplex: "half" } as unknown as RequestInit;
    const res = await POST(new Request("http://localhost/api/plan", init));
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: "could not read request body" });
    const events = unreadableBody(logs);
    assert.equal(events.length, 1);
    assert.equal(events[0].route, "plan");
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

test("a readable plan body logs no sightwork_unreadable_body", async () => {  const saved = Object.fromEntries(KEY_VARS.map((k) => [k, process.env[k]]));
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
    assert.deepEqual(unreadableBody(logs), []);
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
