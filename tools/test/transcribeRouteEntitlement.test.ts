/**
 * POST /api/transcribe access-code entitlement (2026-11-13): the same gate
 * as POST /api/plan, at the top, so a paid run's split transcribe call is
 * not stuck behind the tester-code gate on long narration. Billing off falls
 * through untouched; a dead code is 402, a Stripe error is 503, a good code
 * proceeds — and no pack tally happens here (the plan run records the use).
 * Keyless, Stripe + ASR stubbed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { POST } from "../../src/app/api/transcribe/route";
import { issueAccessCode } from "../../src/lib/billing/accessCode";

const SECRET = "x".repeat(40);
const BILLING_ENV = {
  SIGHTWORK_BILLING: "on",
  STRIPE_SECRET_KEY: "sk_test_abc123",
  SIGHTWORK_ACCESS_SECRET: SECRET,
};
const CUSTOMER = "cus_abc123456";
const KEY_VARS = ["MODEL_API_KEY", "META_API_KEY", "BASETEN_API_KEY"];
const ENV_VARS = [...KEY_VARS, ...Object.keys(BILLING_ENV)];

const pack = issueAccessCode(
  { kind: "pack", stripeId: CUSTOMER, live: false, issuedAt: 1 },
  SECRET,
);
const sub = issueAccessCode(
  { kind: "sub", stripeId: "sub_Abc123456", live: false, issuedAt: 1 },
  SECRET,
);

/** A tiny PCM WAV: 44-byte header plus a few silent samples (mono 16-bit 16 kHz). */
function wav(): string {
  const data = Buffer.alloc(32);
  const h = Buffer.alloc(44);
  h.write("RIFF", 0, "ascii");
  h.writeUInt32LE(36 + data.length, 4);
  h.write("WAVE", 8, "ascii");
  h.write("fmt ", 12, "ascii");
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(16000, 24);
  h.writeUInt32LE(32000, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36, "ascii");
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]).toString("base64");
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
 * POST with the given env, code header, and body; Stripe and Meta ASR are
 * stubbed by URL. Returns the status, parsed JSON, and Stripe call counts.
 */
async function run(
  payload: string,
  opts: { env?: Record<string, string>; code?: string; fetchImpl?: StripeStub } = {},
): Promise<{
  status: number;
  json: Record<string, unknown>;
  stripeCalls: number;
  stripePosts: number;
  logs: string[];
}> {
  const saved = Object.fromEntries(ENV_VARS.map((k) => [k, process.env[k]]));
  for (const k of KEY_VARS) delete process.env[k];
  process.env.MODEL_API_KEY = "test-meta-key";
  for (const [k, v] of Object.entries(opts.env ?? {})) process.env[k] = v;
  const realFetch = globalThis.fetch;
  const realError = console.error;
  const realLog = console.log;
  let stripeCalls = 0;
  let stripePosts = 0;
  const logs: string[] = [];
  const stub = opts.fetchImpl ?? never;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    if (url.startsWith("https://api.stripe.com/v1/")) {
      stripeCalls++;
      if (method === "POST") stripePosts++;
      return stub(url, init);
    }
    if (url.startsWith("https://api.meta.ai/v1/asr/transcribe")) {
      return new Response(
        JSON.stringify({
          audioDurationMs: 42000,
          turns: [{ startMs: 0, endMs: 2000, transcript: "hello there" }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;
  console.error = () => {};
  console.log = (...args: unknown[]) => {
    logs.push(args.map((a) => String(a)).join(" "));
  };
  try {
    const headers: Record<string, string> = {};
    if (opts.code !== undefined) headers["x-sightwork-access-code"] = opts.code;
    const res = await POST(
      new Request("http://localhost/api/transcribe", { method: "POST", headers, body: payload }),
    );
    return { status: res.status, json: (await res.json()) as Record<string, unknown>, stripeCalls, stripePosts, logs };
  } finally {
    globalThis.fetch = realFetch;
    console.error = realError;
    console.log = realLog;
    for (const k of ENV_VARS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

const emptyBody = JSON.stringify({ audioWavBase64: "" });
const wavBody = JSON.stringify({ audioWavBase64: wav() });

/** Stripe answers for a pack customer with `used` plans used and one paid pack5 session (bought=5). */
function packStripe(used = "2"): StripeStub {
  return async (url: string) => {
    if (url.includes("/checkout/sessions")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: [{ id: "cs_test1", mode: "payment", payment_status: "paid", metadata: { sightwork_plan: "pack5" } }],
          has_more: false,
        }),
      };
    }
    return { ok: true, status: 200, json: async () => ({ metadata: { sightwork_plans_used: used } }) };
  };
}

/** Reasons from the sightwork_entitlement_denied log lines, in order. */
function denials(logs: string[]): string[] {
  return logs
    .map((l) => {
      try {
        return JSON.parse(l) as { event?: string; reason?: string };
      } catch {
        return null;
      }
    })
    .filter((o): o is { event: string; reason: string } => o?.event === "sightwork_entitlement_denied")
    .map((o) => o.reason);
}

test("billing off: any access-code header falls through, Stripe never called", async () => {
  const { status, json, stripeCalls, logs } = await run(emptyBody, {
    env: { SIGHTWORK_BILLING: "" },
    code: "sw1.garbage",
  });
  assert.equal(stripeCalls, 0);
  assert.deepEqual(denials(logs), []);
  assert.equal(status, 200);
  assert.deepEqual(json, { transcript: null, transcriptTurns: [], costUsd: 0 });
});

test("billing on: an invalid code is 402 and never reaches Stripe", async () => {
  const { status, json, stripeCalls, logs } = await run(emptyBody, {
    env: BILLING_ENV,
    code: "sw1.a.b",
  });
  assert.equal(stripeCalls, 0);
  assert.equal(status, 402);
  assert.deepEqual(json, { error: "That access code isn't active." });
  assert.deepEqual(denials(logs), ["invalid"]);
});

test("billing on: a canceled subscription is 402 after one Stripe check", async () => {
  const { status, json, stripeCalls, logs } = await run(emptyBody, {
    env: BILLING_ENV,
    code: sub,
    fetchImpl: stripe(200, { status: "canceled" }),
  });
  assert.equal(stripeCalls, 1);
  assert.equal(status, 402);
  assert.deepEqual(json, { error: "That access code isn't active." });
  assert.deepEqual(denials(logs), ["inactive"]);
});

test("billing on: a Stripe error is 503, not 402", async () => {
  const { status, json, stripeCalls, logs } = await run(emptyBody, {
    env: BILLING_ENV,
    code: sub,
    fetchImpl: stripe(500, {}),
  });
  assert.equal(stripeCalls, 1);
  assert.equal(status, 503);
  assert.deepEqual(json, { error: "We can't check your plan right now. Try again shortly." });
  assert.deepEqual(denials(logs), ["unavailable"]);
});

test("billing on: an active subscription proceeds to the empty transcript", async () => {
  const { status, json, stripeCalls } = await run(emptyBody, {
    env: BILLING_ENV,
    code: sub,
    fetchImpl: stripe(200, { status: "active" }),
  });
  assert.equal(stripeCalls, 1);
  assert.equal(status, 200);
  assert.deepEqual(json, { transcript: null, transcriptTurns: [], costUsd: 0 });
});

test("the gate runs before the body is read: a dead code with a malformed body is 402, not 400", async () => {
  const { status, json, stripeCalls } = await run("not json", {
    env: BILLING_ENV,
    code: "sw1.a.b",
  });
  assert.equal(stripeCalls, 0);
  assert.equal(status, 402);
  assert.deepEqual(json, { error: "That access code isn't active." });
});

test("billing on: a pack code transcribes and records nothing here", async () => {
  const { status, json, stripeCalls, stripePosts } = await run(wavBody, {
    env: BILLING_ENV,
    code: pack,
    fetchImpl: packStripe(),
  });
  // Gate only: customer GET + sessions list. No recordPackUse POST.
  assert.equal(stripeCalls, 2);
  assert.equal(stripePosts, 0);
  assert.equal(status, 200);
  assert.equal(json.transcript, "[0.0] hello there");
  assert.equal(json.costUsd, 0.0021);
});

test("billing on: a used-up pack is 402 with reason used-up", async () => {
  const { status, json, stripeCalls, stripePosts, logs } = await run(emptyBody, {
    env: BILLING_ENV,
    code: pack,
    fetchImpl: packStripe("5"),
  });
  // Gate only: customer GET + sessions list. No ASR call, no tally POST.
  assert.equal(stripeCalls, 2);
  assert.equal(stripePosts, 0);
  assert.equal(status, 402);
  assert.deepEqual(json, { error: "That access code isn't active.", reason: "used-up" });
  assert.deepEqual(denials(logs), ["used-up"]);
});
