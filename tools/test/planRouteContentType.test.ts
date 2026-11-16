/** POST /api/plan Content-Type check (2026-11-16, security pass #7):
 * the route only accepts JSON bodies, so a request that does not
 * declare application/json is refused with 415 before the body is
 * read, and leaves a countable sightwork_wrong_content_type log
 * event (same shape as the other refusal logs). A bare string body
 * arrives as text/plain (undici's default) and would otherwise be
 * parsed as JSON anyway. The real browser client sends
 * application/json, so no valid request changes. No fetch, no key:
 * the 415 fires before any wiring. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { POST } from "../../src/app/api/plan/route";
import type { PlanJobStatus } from "../../src/lib/types";

/** sightwork_wrong_content_type events from the captured console.log lines. */
function wrongContentType(logs: string[]): { route?: string }[] {
  return logs
    .map((l) => {
      try {
        return JSON.parse(l) as { event?: string; route?: string };
      } catch {
        return null;
      }
    })
    .filter(
      (o): o is { event: string; route: string } =>
        o?.event === "sightwork_wrong_content_type",
    );
}

/** sightwork_invalid_request events from the captured console.log lines. */
function invalidRequest(logs: string[]): { route?: string }[] {
  return logs
    .map((l) => {
      try {
        return JSON.parse(l) as { event?: string; route?: string };
      } catch {
        return null;
      }
    })
    .filter(
      (o): o is { event: string; route: string } =>
        o?.event === "sightwork_invalid_request",
    );
}

/** Run fn while capturing console.log lines. */
async function withLogs(fn: (logs: string[]) => Promise<void>): Promise<void> {
  const prevLog = console.log;
  const logs: string[] = [];
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  try {
    await fn(logs);
  } finally {
    console.log = prevLog;
  }
}

function post(body: string, contentType?: string): Request {
  return new Request("http://localhost/api/plan", {
    method: "POST",
    ...(contentType !== undefined ? { headers: { "Content-Type": contentType } } : {}),
    body,
  });
}

async function streamLines(res: Response): Promise<PlanJobStatus[]> {
  const text = await res.text();
  return text.split("\n").filter(Boolean).map((l) => JSON.parse(l) as PlanJobStatus);
}

test("a text/plain plan request answers 415 and logs sightwork_wrong_content_type", async () => {
  await withLogs(async (logs) => {
    const res = await POST(post(JSON.stringify({ durationSec: 2, frames: [] }), "text/plain"));
    assert.equal(res.status, 415);
    const body = (await res.json()) as { error?: string };
    assert.match(body.error ?? "", /Content-Type/);
    const events = wrongContentType(logs);
    assert.equal(events.length, 1);
    assert.equal(events[0].route, "plan");
  });
});

test("a plan request with no Content-Type answers 415 and logs sightwork_wrong_content_type", async () => {
  await withLogs(async (logs) => {
    const res = await POST(post(JSON.stringify({ durationSec: 2, frames: [] })));
    assert.equal(res.status, 415);
    const events = wrongContentType(logs);
    assert.equal(events.length, 1);
    assert.equal(events[0].route, "plan");
  });
});

test("application/json with a charset passes the check and reaches validation", async () => {
  await withLogs(async (logs) => {
    // "{}" is not a valid plan request, so a pass-through must reach
    // validation (failed line + invalid-request event), not the 415.
    const res = await POST(post("{}", "application/json; charset=utf-8"));
    assert.equal(res.status, 200);
    const lines = await streamLines(res);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].state, "failed");
    assert.equal(wrongContentType(logs).length, 0);
    const refused = invalidRequest(logs);
    assert.equal(refused.length, 1);
    assert.equal(refused[0].route, "plan");
  });
});
