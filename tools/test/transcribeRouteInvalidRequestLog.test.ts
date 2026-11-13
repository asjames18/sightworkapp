/** POST /api/transcribe invalid-request log (2026-11-13): a body that fails validation is refused with 400; the refusal now leaves a server-log trace (sightwork_invalid_request, route only, never the request content), the same audit gap the entitlement-denial, rate-limit, body-too-large and unreadable-body logs closed. Keyless, billing off. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { POST } from "../../src/app/api/transcribe/route";

/** Invalid-request events from the captured console.log lines, in order. */
function invalidRequest(logs: string[]): { route?: string }[] {
  return logs
    .map((l) => {
      try {
        return JSON.parse(l) as { event?: string; route?: string };
      } catch {
        return null;
      }
    })
    .filter((o): o is { event: string; route: string } => o?.event === "sightwork_invalid_request");
}

test("an invalid transcribe body is 400 and logs sightwork_invalid_request", async () => {
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
        body: JSON.stringify({ audioWavBase64: 123 }),
      }),
    );
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), {
      error: "That transcribe request was incomplete. Try again.",
    });
    const events = invalidRequest(logs);
    assert.equal(events.length, 1);
    assert.equal(events[0].route, "transcribe");
  } finally {
    console.error = realError;
    console.log = realLog;
    if (savedBilling === undefined) delete process.env.SIGHTWORK_BILLING;
    else process.env.SIGHTWORK_BILLING = savedBilling;
  }
});

test("a valid transcribe body logs no sightwork_invalid_request", async () => {
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
    assert.deepEqual(invalidRequest(logs), []);
  } finally {
    console.error = realError;
    console.log = realLog;
    if (savedBilling === undefined) delete process.env.SIGHTWORK_BILLING;
    else process.env.SIGHTWORK_BILLING = savedBilling;
  }
});
