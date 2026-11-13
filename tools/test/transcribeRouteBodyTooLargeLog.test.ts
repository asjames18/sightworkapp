/** POST /api/transcribe body-too-large log (2026-11-13): a body over the 46 MB route cap is refused with 413; the refusal now leaves a server-log trace (sightwork_body_too_large, route + bytes, never the body), the same audit gap the entitlement-denial and rate-limit logs closed. Keyless, billing off. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_TRANSCRIBE_BODY_BYTES, POST } from "../../src/app/api/transcribe/route";

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

test("an oversize transcribe body is 413 and logs sightwork_body_too_large", async () => {
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
    const body = "x".repeat(MAX_TRANSCRIBE_BODY_BYTES + 1);
    const res = await POST(
      new Request("http://localhost/api/transcribe", { method: "POST", body }),
    );
    assert.equal(res.status, 413);
    assert.deepEqual(await res.json(), { error: "transcribe request body too large" });
    const events = bodyTooLarge(logs);
    assert.equal(events.length, 1);
    assert.equal(events[0].route, "transcribe");
    assert.equal(events[0].bytes, new TextEncoder().encode(body).length);
  } finally {
    console.error = realError;
    console.log = realLog;
    if (savedBilling === undefined) delete process.env.SIGHTWORK_BILLING;
    else process.env.SIGHTWORK_BILLING = savedBilling;
  }
});

test("a normal transcribe body logs no sightwork_body_too_large", async () => {
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
    // No narration: the free empty-audio return, no call, no log.
    const res = await POST(
      new Request("http://localhost/api/transcribe", {
        method: "POST",
        body: JSON.stringify({}),
      }),
    );
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { transcript: null, transcriptTurns: [], costUsd: 0 });
    assert.deepEqual(bodyTooLarge(logs), []);
  } finally {
    console.error = realError;
    console.log = realLog;
    if (savedBilling === undefined) delete process.env.SIGHTWORK_BILLING;
    else process.env.SIGHTWORK_BILLING = savedBilling;
  }
});
