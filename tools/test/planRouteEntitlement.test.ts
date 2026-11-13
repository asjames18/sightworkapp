/** POST /api/plan access-code entitlement (2026-11-13): a request carrying x-sightwork-access-code is checked with Stripe before the body is read. Billing off falls through untouched; a dead code is 402, a Stripe error is 503, and a good code proceeds. Keyless, Stripe mocked. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { POST } from "../../src/app/api/plan/route";
import { issueAccessCode } from "../../src/lib/billing/accessCode";
import type { PlanJobStatus } from "../../src/lib/types";

const SECRET = "x".repeat(40);
const BILLING_ENV = {
  SIGHTWORK_BILLING: "on",
  STRIPE_SECRET_KEY: "sk_test_abc123",
  SIGHTWORK_ACCESS_SECRET: SECRET,
};
const KEY_VARS = ["MODEL_API_KEY", "META_API_KEY", "BASETEN_API_KEY"];
const ENV_VARS = [...KEY_VARS, ...Object.keys(BILLING_ENV)];

const sub = issueAccessCode(
  { kind: "sub", stripeId: "sub_Abc123456", live: false, issuedAt: 1 },
  SECRET,
);

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

type StripeStub = (url: string, init: unknown) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>;

function stripe(status: number, json: unknown): StripeStub {
  return async () => ({ ok: status < 300, status, json: async () => json });
}

const never: StripeStub = async () => {
  throw new Error("must not call Stripe");
};

/**
 * POST with the given env and Stripe stub; returns the status, the parsed
 * JSON error when the response is JSON, the NDJSON lines when it streams,
 * and how many times Stripe was called.
 */
async function run(
  payload: string,
  opts: { env?: Record<string, string>; code?: string; fetchImpl?: StripeStub } = {},
): Promise<{
  status: number;
  json: { error?: string } | null;
  lines: PlanJobStatus[];
  stripeCalls: number;
}> {
  const saved = Object.fromEntries(ENV_VARS.map((k) => [k, process.env[k]]));
  for (const k of KEY_VARS) delete process.env[k];
  for (const [k, v] of Object.entries(opts.env ?? {})) process.env[k] = v;
  const realFetch = globalThis.fetch;
  const realError = console.error;
  let stripeCalls = 0;
  const stub = opts.fetchImpl ?? never;
  globalThis.fetch = (async (...args: unknown[]) => {
    stripeCalls++;
    return stub(args[0] as string, args[1]);
  }) as typeof fetch;
  console.error = () => {};
  try {
    const headers: Record<string, string> = {};
    if (opts.code !== undefined) headers["x-sightwork-access-code"] = opts.code;
    const res = await POST(
      new Request("http://localhost/api/plan", { method: "POST", headers, body: payload }),
    );
    const contentType = res.headers.get("Content-Type") ?? "";
    if (contentType.includes("application/json")) {
      return { status: res.status, json: (await res.json()) as { error?: string }, lines: [], stripeCalls };
    }
    const text = await res.text();
    const lines = text
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as PlanJobStatus);
    return { status: res.status, json: null, lines, stripeCalls };
  } finally {
    globalThis.fetch = realFetch;
    console.error = realError;
    for (const k of ENV_VARS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

test("billing off: any access-code header falls through, Stripe never called", async () => {
  const { status, json, lines, stripeCalls } = await run(body(), {
    env: { SIGHTWORK_BILLING: "" },
    code: "sw1.garbage",
  });
  assert.equal(stripeCalls, 0);
  assert.equal(json, null);
  assert.equal(lines[0].state, "running");
  assert.equal((lines[0] as { step?: string }).step, "uploading");
  assert.equal(status, 200);
});

test("billing on: an invalid code is 402 and never reaches Stripe", async () => {
  const { status, json, lines, stripeCalls } = await run(body(), {
    env: BILLING_ENV,
    code: "sw1.a.b",
  });
  assert.equal(stripeCalls, 0);
  assert.equal(status, 402);
  assert.deepEqual(json, { error: "That access code isn't active." });
  assert.deepEqual(lines, []);
});

test("billing on: a canceled subscription is 402 after one Stripe check", async () => {
  const { status, json, stripeCalls } = await run(body(), {
    env: BILLING_ENV,
    code: sub,
    fetchImpl: stripe(200, { status: "canceled" }),
  });
  assert.equal(stripeCalls, 1);
  assert.equal(status, 402);
  assert.deepEqual(json, { error: "That access code isn't active." });
});

test("billing on: a Stripe error is 503, not 402", async () => {
  const { status, json, stripeCalls } = await run(body(), {
    env: BILLING_ENV,
    code: sub,
    fetchImpl: stripe(500, {}),
  });
  assert.equal(stripeCalls, 1);
  assert.equal(status, 503);
  assert.deepEqual(json, { error: "We can't check your plan right now. Try again shortly." });
});

test("billing on: an active subscription proceeds past the gate", async () => {
  const { status, json, lines, stripeCalls } = await run(body(), {
    env: BILLING_ENV,
    code: sub,
    fetchImpl: stripe(200, { status: "active" }),
  });
  assert.equal(stripeCalls, 1);
  assert.equal(json, null);
  assert.equal(status, 200);
  assert.deepEqual(lines[0], { state: "running", step: "uploading" });
});

test("the gate runs before the body is read: a dead code with a malformed body is 402, not a failed uploading line", async () => {
  const { status, json, lines, stripeCalls } = await run("not json", {
    env: BILLING_ENV,
    code: "sw1.a.b",
  });
  assert.equal(stripeCalls, 0);
  assert.equal(status, 402);
  assert.deepEqual(json, { error: "That access code isn't active." });
  assert.deepEqual(lines, []);
});
