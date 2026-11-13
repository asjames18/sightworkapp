/** POST /api/transcribe unreadable-body log (2026-11-13): a body that cannot be read or is not JSON is refused with 400; the refusal now leaves a server-log trace (sightwork_unreadable_body, route only, never the body), the same audit gap the entitlement-denial, rate-limit and body-too-large logs closed. Keyless, billing off. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { POST } from "../../src/app/api/transcribe/route";

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

test("a non-JSON transcribe body is 400 and logs sightwork_unreadable_body", async () => {
  const savedBilling = process.env.SIGHTWORK_BILLING;
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
      new Request("http://localhost/api/transcribe", { method: "POST", body: "{not json" }),
    );
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: "could not read transcribe request" });
    const events = unreadableBody(logs);
    assert.equal(events.length, 1);
    assert.equal(events[0].route, "transcribe");
  } finally {
    console.error = realError;
    console.log = realLog;
    if (savedBilling === undefined) delete process.env.SIGHTWORK_BILLING;
    else process.env.SIGHTWORK_BILLING = savedBilling;
  }
});

test("an unreadable transcribe body is 400 and logs sightwork_unreadable_body", async () => {
  const savedBilling = process.env.SIGHTWORK_BILLING;
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
    const res = await POST(new Request("http://localhost/api/transcribe", init));
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: "could not read transcribe request body" });
    const events = unreadableBody(logs);
    assert.equal(events.length, 1);
    assert.equal(events[0].route, "transcribe");
  } finally {
    console.error = realError;
    console.log = realLog;
    if (savedBilling === undefined) delete process.env.SIGHTWORK_BILLING;
    else process.env.SIGHTWORK_BILLING = savedBilling;
  }
});

test("a readable transcribe body logs no sightwork_unreadable_body", async () => {
  const savedBilling = process.env.SIGHTWORK_BILLING;
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
      new Request("http://localhost/api/transcribe", {
        method: "POST",
        body: JSON.stringify({}),
      }),
    );
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { transcript: null, transcriptTurns: [], costUsd: 0 });
    assert.deepEqual(unreadableBody(logs), []);
  } finally {
    console.error = realError;
    console.log = realLog;
    if (savedBilling === undefined) delete process.env.SIGHTWORK_BILLING;
    else process.env.SIGHTWORK_BILLING = savedBilling;
  }
});
