/**
 * POST /api/plan with the reviewing wiring (f64a453), end to end through the real route and the real
 * Baseten client, offline: fetch is stubbed. Baseten answers the reason call with the stored
 * sanctuary plan plus a planted smell, then answers the review call per prompt 06; every Meta
 * endpoint answers 400, so the optional Meta steps skip. Checks the streamed reviewing line, the
 * plan.review verdicts, and that a reviewer that errors still ships the plan with ran:false.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { POST } from "../../src/app/api/plan/route";
import { planReview, reviewLine, verdictFor } from "../../src/lib/review";
import type { PlanJobStatus, WorkPlan } from "../../src/lib/types";
import sanctuary from "../../src/lib/examples/sanctuary-run.json";

const S = sanctuary as unknown as WorkPlan;
const SMELL = "Musty smell behind the stage curtain";
const JPEG = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2w==";
const ENV_VARS = ["MODEL_API_KEY", "META_API_KEY", "BASETEN_API_KEY", "PLAN_PROVIDER", "BASETEN_API_BASE_URL", "META_API_BASE_URL"];

function reasonJson(): unknown {
  const issues = JSON.parse(JSON.stringify(S.issues));
  issues.push({
    ...issues[issues.length - 1],
    rank: issues.length + 1,
    title: SMELL,
    detail: "A damp, musty smell near the back curtain.",
    severity: "medium",
    frameIndex: 2,
    frameTimeSec: S.frames?.[2]?.tSec ?? 10,
    proofFrames: [{ frameIndex: 2, tSec: S.frames?.[2]?.tSec ?? 10 }],
  });
  return {
    spaceName: S.spaceName,
    generatedFrom: S.generatedFrom,
    inventory: S.inventory,
    issues,
    materials: S.materials,
    workOrder: S.workOrder,
    transcriptSummary: null,
    saidVsSeen: [],
    heroFrameIndex: S.heroFrameIndex,
  };
}

/** Text of the single user message's text part(s) in a chat/completions body. */
function promptText(body: string): string {
  const parsed = JSON.parse(body) as { messages: { content: string | { type: string; text?: string }[] }[] };
  const content = parsed.messages[0].content;
  if (typeof content === "string") return content;
  return content.filter((p) => p.type === "text").map((p) => p.text ?? "").join("\n");
}

function imageCount(body: string): number {
  const parsed = JSON.parse(body) as { messages: { content: string | { type: string }[] }[] };
  const content = parsed.messages[0].content;
  return typeof content === "string" ? 0 : content.filter((p) => p.type !== "text").length;
}

function completion(json: unknown): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { content: JSON.stringify(json) } }], usage: { prompt_tokens: 1000, completion_tokens: 500 } }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

type Reviewer = "honest" | "down";
interface Run {
  lines: PlanJobStatus[];
  baseten: { prompt: string; images: number }[];
  meta: number;
}

async function run(reviewer: Reviewer): Promise<Run> {
  const saved = Object.fromEntries(ENV_VARS.map((k) => [k, process.env[k]]));
  for (const k of ENV_VARS) delete process.env[k];
  process.env.BASETEN_API_KEY = "test-baseten-key";
  process.env.MODEL_API_KEY = "test-meta-key";
  const realFetch = globalThis.fetch;
  const realError = console.error;
  const realLog = console.log;
  const realWarn = console.warn;
  const baseten: { prompt: string; images: number }[] = [];
  let meta = 0;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith("https://inference.baseten.co/")) {
      const body = String(init?.body ?? "");
      const prompt = promptText(body);
      baseten.push({ prompt, images: imageCount(body) });
      if (!/Photo A:/.test(prompt)) return completion(reasonJson());
      if (reviewer === "down") return new Response("upstream error", { status: 500 });
      const ids = prompt
        .split("\n")
        .filter((l) => l.startsWith("id "))
        .map((l) => ({ id: l.split(" | ")[0].slice(3), smell: l.includes(SMELL) }));
      return completion({
        ran: true,
        items: ids.map(({ id, smell }) => ({
          problemId: id,
          verified: !smell,
          reason: smell ? "A smell can't be seen in any photo." : "The photo shows it.",
        })),
      });
    }
    meta++;
    return new Response(JSON.stringify({ error: { message: "offline test" } }), { status: 400 });
  }) as typeof fetch;
  console.error = () => {};
  console.log = () => {};
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
    const res = await POST(new Request("http://localhost/api/plan", { method: "POST", headers: { "Content-Type": "application/json" }, body: payload }));
    const text = await res.text();
    return { lines: text.split("\n").filter(Boolean).map((l) => JSON.parse(l) as PlanJobStatus), baseten, meta };
  } finally {
    globalThis.fetch = realFetch;
    console.error = realError;
    console.log = realLog;
    console.warn = realWarn;
    for (const k of ENV_VARS) if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
}

function donePlan(lines: PlanJobStatus[]): WorkPlan {
  const last = lines.at(-1) as { state: string; plan?: WorkPlan };
  assert.equal(last.state, "done", `run ended ${JSON.stringify(last).slice(0, 300)}`);
  assert.ok(last.plan);
  return last.plan;
}

describe("POST /api/plan reviewing (offline, stubbed Baseten)", () => {
  test("planted smell comes back unverified; reviewing streams before done", async () => {
    const { lines, baseten } = await run("honest");
    const plan = donePlan(lines);
    assert.equal(baseten.length, 2, "one reason call, one review call");
    const reviewIdx = lines.findIndex((l) => l.state === "running" && l.step === "reviewing");
    assert.ok(reviewIdx > 0 && reviewIdx < lines.length - 1, "reviewing line before the done line");
    assert.ok(!lines.some((l) => l.state === "failed"));
    const review = planReview(plan);
    assert.equal(review?.ran, true);
    assert.equal(review?.source, "model");
    const smell = plan.issues.find((i) => i.title === SMELL);
    assert.ok(smell);
    assert.equal(verdictFor(review, smell)?.verified, false);
    const n = plan.issues.length;
    assert.equal(reviewLine(review), `Reviewed by a separate check: ${n - 1} of ${n} problems backed by a photo.`);
  });

  test("the review call carries the filled prompt 06 and one image per listed photo", async () => {
    const { baseten } = await run("honest");
    const review = baseten[1];
    assert.doesNotMatch(review.prompt, /\{\{\w+\}\}/);
    const photos = review.prompt.split("\n").filter((l) => /^Photo [A-H]: frame \d+ at \d+:\d\d$/.test(l));
    assert.ok(photos.length > 0 && photos.length <= 8);
    assert.equal(review.images, photos.length);
  });

  test("a reviewer that errors still ships the plan, with ran:false and no failed line", async () => {
    const { lines } = await run("down");
    const plan = donePlan(lines);
    assert.ok(!lines.some((l) => l.state === "failed"));
    assert.equal(planReview(plan)?.ran, false);
    assert.equal(plan.issues.length, (S.issues?.length ?? 0) + 1);
  });
});
