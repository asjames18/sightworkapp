/** POST /api/transcribe Content-Type check (2026-11-16, security pass
 * #7): the route only accepts JSON bodies, so a request that does not
 * declare application/json is refused with 415 before the body is
 * read, and leaves a countable sightwork_wrong_content_type log event
 * (same shape as the other refusal logs). A bare string body arrives
 * as text/plain (undici's default) and would otherwise be parsed as
 * JSON anyway. The real browser client sends application/json, so no
 * valid request changes. No fetch, no key: the 415 fires before any
 * wiring, and the pass-through case takes the keyless empty-audio path. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { POST } from "../../src/app/api/transcribe/route";

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
  return new Request("http://localhost/api/transcribe", {
    method: "POST",
    ...(contentType !== undefined ? { headers: { "Content-Type": contentType } } : {}),
    body,
  });
}

test("a text/plain transcribe request answers 415 and logs sightwork_wrong_content_type", async () => {
  await withLogs(async (logs) => {
    const res = await POST(post("{}", "text/plain"));
    assert.equal(res.status, 415);
    const body = (await res.json()) as { error?: string };
    assert.match(body.error ?? "", /Content-Type/);
    const events = wrongContentType(logs);
    assert.equal(events.length, 1);
    assert.equal(events[0].route, "transcribe");
  });
});

test("a transcribe request with no Content-Type answers 415 and logs sightwork_wrong_content_type", async () => {
  await withLogs(async (logs) => {
    const res = await POST(post("{}"));
    assert.equal(res.status, 415);
    const events = wrongContentType(logs);
    assert.equal(events.length, 1);
    assert.equal(events[0].route, "transcribe");
  });
});

test("application/json with a charset passes the check and reaches the empty-audio answer", async () => {
  await withLogs(async (logs) => {
    // "{}" carries no narration, so a pass-through must reach the
    // keyless empty-transcript answer, not the 415.
    const res = await POST(post("{}", "application/json; charset=utf-8"));
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      transcript?: unknown;
      transcriptTurns?: unknown[];
      costUsd?: number;
    };
    assert.equal(body.transcript, null);
    assert.deepEqual(body.transcriptTurns, []);
    assert.equal(body.costUsd, 0);
    assert.equal(wrongContentType(logs).length, 0);
  });
});
