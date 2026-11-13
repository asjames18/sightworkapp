/**
 * POST /api/plan pack tally (2026-11-13): a finished plan on a pack code
 * calls recordPackUse right after the done line; a sub code records
 * nothing, a failed tally still ships the plan, and billing off never
 * touches Stripe. A pack with no plans left is 402 with reason "used-up"
 * (2026-11-13), so the client can show the pack-used-up text. The tally
 * is logged on success (sightwork_pack_use, with the new count) and on
 * failure (sightwork_pack_use_failed), so pack usage is auditable from
 * the server log without a separate Stripe read.
 * Keyless, Stripe + Baseten + Meta all stubbed.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { POST } from "../../src/app/api/plan/route";
import { issueAccessCode } from "../../src/lib/billing/accessCode";
import type { PlanJobStatus, WorkPlan } from "../../src/lib/types";
import sanctuary from "../../src/lib/examples/sanctuary-run.json";

const S = sanctuary as unknown as WorkPlan;
const SECRET = "x".repeat(40);
const BILLING_ENV = {
  SIGHTWORK_BILLING: "on",
  STRIPE_SECRET_KEY: "sk_test_abc123",
  SIGHTWORK_ACCESS_SECRET: SECRET,
};
const CUSTOMER = "cus_abc123456";
const ENV_VARS = [
  "MODEL_API_KEY",
  "META_API_KEY",
  "BASETEN_API_KEY",
  "PLAN_PROVIDER",
  "BASETEN_API_BASE_URL",
  "META_API_BASE_URL",
  ...Object.keys(BILLING_ENV),
];

const pack = issueAccessCode(
  { kind: "pack", stripeId: CUSTOMER, live: false, issuedAt: 1 },
  SECRET,
);
const sub = issueAccessCode(
  { kind: "sub", stripeId: "sub_Abc123456", live: false, issuedAt: 1 },
  SECRET,
);

const JPEG = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2w==";

function reasonJson(): unknown {
  return {
    spaceName: S.spaceName,
    generatedFrom: S.generatedFrom,
    inventory: S.inventory,
    issues: S.issues,
    materials: S.materials,
    workOrder: S.workOrder,
    transcriptSummary: null,
    saidVsSeen: [],
    heroFrameIndex: S.heroFrameIndex,
  };
}

function promptText(body: string): string {
  const parsed = JSON.parse(body) as { messages: { content: string | { type: string; text?: string }[] }[] };
  const content = parsed.messages[0].content;
  if (typeof content === "string") return content;
  return content.filter((p) => p.type === "text").map((p) => p.text ?? "").join("\n");
}

function completion(json: unknown): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { content: JSON.stringify(json) } }], usage: { prompt_tokens: 1000, completion_tokens: 500 } }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

interface Run {
  lines: PlanJobStatus[];
  stripeGets: string[];
  stripePosts: { url: string; body: string }[];
  status: number;
  raw: string;
  logs: string[];
}

/**
 * Full POST through the real route with fetch stubbed. Stripe answers the
 * gate (customer used=2, one paid pack5 session bought=5) and the tally
 * (GET used=2, POST records used=3 unless recordPostStatus says otherwise).
 */
async function run(opts: {
  env?: Record<string, string>;
  code?: string;
  recordPostStatus?: number;
  /** Plans used on the pack customer (gate: used >= bought is used-up). */
  used?: string;
}): Promise<Run> {
  const saved = Object.fromEntries(ENV_VARS.map((k) => [k, process.env[k]]));
  for (const k of ENV_VARS) delete process.env[k];
  process.env.BASETEN_API_KEY = "test-baseten-key";
  process.env.MODEL_API_KEY = "test-meta-key";
  for (const [k, v] of Object.entries(opts.env ?? {})) process.env[k] = v;
  const realFetch = globalThis.fetch;
  const realError = console.error;
  const realLog = console.log;
  const realWarn = console.warn;
  const stripeGets: string[] = [];
  const stripePosts: { url: string; body: string }[] = [];
  const logs: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    if (url.startsWith("https://inference.baseten.co/")) {
      const prompt = promptText(String(init?.body ?? ""));
      if (!/Photo A:/.test(prompt)) return completion(reasonJson());
      const ids = prompt
        .split("\n")
        .filter((l) => l.startsWith("id "))
        .map((l) => l.split(" | ")[0].slice(3));
      return completion({
        ran: true,
        items: ids.map((id) => ({ problemId: id, verified: true, reason: "The photo shows it." })),
      });
    }
    if (url.startsWith("https://api.stripe.com/v1/")) {
      if (method === "POST") {
        stripePosts.push({ url, body: String(init?.body ?? "") });
        return new Response(JSON.stringify({ id: CUSTOMER }), {
          status: opts.recordPostStatus ?? 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      stripeGets.push(url);
      if (url.includes("/subscriptions/")) {
        return new Response(JSON.stringify({ status: "active" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/checkout/sessions")) {
        return new Response(
          JSON.stringify({
            data: [{ id: "cs_test1", mode: "payment", payment_status: "paid", metadata: { sightwork_plan: "pack5" } }],
            has_more: false,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ metadata: { sightwork_plans_used: opts.used ?? "2" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ error: { message: "offline test" } }), { status: 400 });
  }) as typeof fetch;
  console.error = () => {};
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  console.warn = () => {};
  try {
    const payload = JSON.stringify({
      spaceName: S.spaceName,
      spaceType: "sanctuary",
      durationSec: 48,
      frames: (S.frames ?? []).map((f) => ({ tSec: f.tSec, dataUrl: JPEG })),
      transcript: null,
      transcriptTurns: [],
    });
    const headers: Record<string, string> = {};
    if (opts.code !== undefined) headers["x-sightwork-access-code"] = opts.code;
    const res = await POST(
      new Request("http://localhost/api/plan", { method: "POST", headers, body: payload }),
    );
    const text = await res.text();
    return {
      lines: text.split("\n").filter(Boolean).map((l) => JSON.parse(l) as PlanJobStatus),
      stripeGets,
      stripePosts,
      status: res.status,
      raw: text,
      logs,
    };
  } finally {
    globalThis.fetch = realFetch;
    console.error = realError;
    console.log = realLog;
    console.warn = realWarn;
    for (const k of ENV_VARS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

function donePlan(lines: PlanJobStatus[]): WorkPlan {
  const last = lines.at(-1) as { state: string; plan?: WorkPlan };
  assert.equal(last.state, "done", `run ended ${JSON.stringify(last).slice(0, 300)}`);
  assert.ok(last.plan);
  return last.plan;
}

describe("POST /api/plan pack tally (offline, stubbed Stripe + Baseten)", () => {
  test("pack code: a finished plan records one use (used 2 -> 3)", async () => {
    const { lines, stripeGets, stripePosts } = await run({ env: BILLING_ENV, code: pack });
    donePlan(lines);
    assert.ok(!lines.some((l) => l.state === "failed"));
    // Gate: customer GET + sessions list; tally: customer GET + POST.
    assert.equal(stripeGets.filter((u) => u.includes("/customers/")).length, 2);
    assert.equal(stripeGets.filter((u) => u.includes("/checkout/sessions")).length, 1);
    assert.equal(stripePosts.length, 1);
    assert.ok(stripePosts[0].url.includes(`/customers/${CUSTOMER}`));
    assert.equal(
      new URLSearchParams(stripePosts[0].body).get("metadata[sightwork_plans_used]"),
      "3",
    );
  });

  test("sub code: a finished plan records nothing", async () => {
    const { lines, stripeGets, stripePosts } = await run({ env: BILLING_ENV, code: sub });
    donePlan(lines);
    assert.ok(!lines.some((l) => l.state === "failed"));
    assert.equal(stripeGets.filter((u) => u.includes("/subscriptions/")).length, 1);
    assert.equal(stripePosts.length, 0);
  });

  test("pack code: a finished plan logs the tally (used 3)", async () => {
    const { lines, logs } = await run({ env: BILLING_ENV, code: pack });
    donePlan(lines);
    const tally = logs.map((l) => {
      try {
        return JSON.parse(l) as unknown;
      } catch {
        return null;
      }
    });
    assert.deepEqual(
      tally.find((e) => (e as { event?: unknown } | null)?.event === "sightwork_pack_use"),
      { event: "sightwork_pack_use", customer: CUSTOMER, used: 3 },
    );
  });

  test("pack code: a failed tally still ships the plan", async () => {
    const { lines, stripePosts, logs } = await run({ env: BILLING_ENV, code: pack, recordPostStatus: 500 });
    donePlan(lines);
    assert.ok(!lines.some((l) => l.state === "failed"));
    assert.equal(stripePosts.length, 1, "tally was attempted, not skipped");
    assert.ok(
      logs.some((l) => l.includes('"event":"sightwork_pack_use_failed"')),
      "tally failure is logged",
    );
  });

  test("billing off: a pack code runs free and Stripe is never called", async () => {
    const { lines, stripeGets, stripePosts } = await run({
      env: { SIGHTWORK_BILLING: "" },
      code: pack,
    });
    donePlan(lines);
    assert.ok(!lines.some((l) => l.state === "failed"));
    assert.equal(stripeGets.length, 0);
    assert.equal(stripePosts.length, 0);
  });

  test("pack code with no plans left: 402 carries reason used-up", async () => {
    // Gate: used 5, bought 5 (one paid pack5 session), so the run never starts.
    const { status, raw, stripePosts } = await run({ env: BILLING_ENV, code: pack, used: "5" });
    assert.equal(status, 402);
    assert.equal(stripePosts.length, 0);
    assert.deepEqual(JSON.parse(raw), {
      error: "That access code isn't active.",
      reason: "used-up",
    });
  });
});
