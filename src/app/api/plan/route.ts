/**
 * POST /api/plan: one PlanRequest in, one NDJSON stream out.
 *
 * The browser runner (src/lib/client/apiPlanJob.ts) posts the picked
 * video's frames + narration and reads one PlanJobStatus per line:
 * running statuses in stage order, then a final done or failed line.
 * This route emits the first "uploading" status itself, right after
 * it parses the body; runPlan starts at "listening". Right after
 * validation it sends a second uploading line carrying the frame-count
 * check (uploadCheck), matching runPlan's check-line pattern, before
 * any wiring runs.
 *
 * Wiring: runPlan's step deps get the real callers plus the
 * per-request prompt builders from planPrompts.ts, so prompts 03
 * and 05 are filled with this request's frames, transcript, and region.
 * Reviewing (prompt 06): wired here with the reason step's provider
 * caller plus buildReviewPrompt, so a real run emits "reviewing" and
 * lands plan.review; a failed review ships ran:false, never a failed run.
 * Provider switch (PLAN_PROVIDER, default "baseten"): the reason step
 * — the main plan engine per Antonio's Oct 27 decision — runs on
 * Baseten Muse Spark Open, or on Meta Muse Spark when
 * PLAN_PROVIDER=meta. The other steps stay on Meta for now: the cost
 * step's prompt 05 needs web search, which the Baseten caller does
 * not offer, and SAM 3.1 / Muse Image are Meta-only steps that skip
 * cleanly when Meta is blocked. So a Meta key is still needed at
 * wiring time even in baseten mode; the reason engine is the only
 * step that moves. The plan's meta.planProvider records which engine
 * wrote the reason step, so a finished plan names its own engine.
 * SEGMENT_CONCURRENCY, when set to a whole number >= 1, caps SAM calls in
 * flight for the segment step; unset keeps the segment default.
 * The shared usage tracker enforces the $10 spike cap in code, and
 * every call it records is logged server-side when the run finishes, successfully or not.
 *
 * No Meta API calls happen on import, and the key is read from
 * process.env only (MODEL_API_KEY or META_API_KEY) by the callers.
 * The UI never sees provider text: failures stream as PlanJobStatus
 * failed lines with plain messages, and the detail rides on the
 * server log only. A failed line carries costUsd when the run already
 * billed model calls, so the client can keep the run-cost line
 * accurate; it is omitted when nothing billed or unknown.
 * Aborting the request stops the run.
 *
 * Access-code entitlement (2026-11-13): a request carrying
 * x-sightwork-access-code is checked with Stripe before the body is
 * read, so a dead code fails fast (402, or 503 when Stripe cannot
 * be reached) without uploading frames; when billing is off the
 * check is a no-op and the tester-code gate in proxy.ts stays the
 * only gate. The check depends only on the header, never the body,
 * so there is no reason it must sit after body validation — and
 * sitting first keeps invalid-code probes out of the rate limiter.
 * After the done line, a finished plan on a pack code is recorded
 * with recordPackUse (best-effort, logged on success and failure); a sub code
 * logs its use (sightwork_sub_use, no Stripe write), and billing off records nothing.
 */

import { checkEntitlement, type Entitlement } from "../../../lib/billing/entitlement";
import { recordPackUse } from "../../../lib/billing/packUse";
import { createBasetenClient, createReasonBasetenCaller } from "../../../lib/meta/baseten";
import {
  createCostSparkCaller,
  createMetaClient,
  createReasonSparkCaller,
} from "../../../lib/meta/client";
import { IMAGE_MODEL, createImageCaller } from "../../../lib/meta/image";
import { createSamSegmentCaller } from "../../../lib/meta/sam";
import { createAsrTranscribeCaller } from "../../../lib/meta/transcribe";
import { buildReviewPrompt } from "../../../lib/reviewPrompt";
import {
  COST_PROMPT_TEMPLATE,
  COST_SCHEMA,
  REASON_PROMPT_TEMPLATE,
  REASON_SCHEMA,
  buildCostPrompt,
  buildReasonPrompt,
} from "../../../lib/pipeline/planPrompts";
import {
  planBodyTooLarge,
  validatePlanRequest,
} from "../../../lib/pipeline/planRequest";
import {
  RATE_LIMIT_REQUESTS,
  RATE_LIMIT_WINDOW_MS,
  clientIp,
  createRateLimiter,
} from "../../../lib/pipeline/rateLimit";
import { createUsageTracker } from "../../../lib/pipeline/usage";
import { PlanStepError, REASON_MAX_FRAMES, runPlan } from "../../../lib/pipeline/runPlan";
import { uploadCheck } from "../../../lib/stepChecks";
import type { PlanJobStatus, PlanRequest, PlanStep } from "../../../lib/types";

export const runtime = "nodejs";

// Explicit Vercel function duration: 300 s is the Hobby maximum and
// the Pro default, so this states the platform limit rather than
// raising it. Plan runs no longer always fit it: a live hosted run
// was cut at 312 s on 2026-11-03 (slow comparing), so the limit IS
// binding on slow runs — runPlan skips picturing and reviewing past
// ~230 s from the handler start so a slow run still ships a plan.
// The 4.5 MB request-body cap is the other binding limit (see the
// 10 MB route cap below, which only applies before the platform cap).
export const maxDuration = 300;

/**
 * The reason step's provider, from PLAN_PROVIDER. Default "baseten"
 * (the main plan engine per Antonio's Oct 27 decision); "meta" runs
 * the reason step on Meta Muse Spark instead. Anything else fails
 * fast here, before any step runs, so a typo never silently picks
 * an engine. Takes an env record so tests can pass one in; defaults
 * to process.env.
 */
export function resolvePlanProvider(
  env: Record<string, string | undefined> = process.env,
): "baseten" | "meta" {
  const raw = env.PLAN_PROVIDER?.trim().toLowerCase();
  if (raw === undefined || raw === "") return "baseten";
  if (raw === "baseten" || raw === "meta") return raw;
  throw new Error(`plan route: unknown PLAN_PROVIDER "${env.PLAN_PROVIDER}" (want baseten or meta)`);
}

/**
 * SAM concurrency for the segment step, from SEGMENT_CONCURRENCY.
 * Blank/unset keeps runSegment's own default (DEFAULT_SEGMENT_CONCURRENCY);
 * a whole number >= 1 is passed through to runPlan as segmentConcurrency.
 * Anything else fails fast here, before any step runs, so a typo never
 * silently picks a pool size. Takes an env record so tests can pass one
 * in; defaults to process.env.
 */
export function resolveSegmentConcurrency(
  env: Record<string, string | undefined> = process.env,
): number | undefined {
  const raw = env.SEGMENT_CONCURRENCY?.trim();
  if (raw === undefined || raw === "") return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(
      `plan route: unknown SEGMENT_CONCURRENCY "${env.SEGMENT_CONCURRENCY}" (want a whole number >= 1)`,
    );
  }
  return value;
}

export const dynamic = "force-dynamic";

/**
 * Per-IP brake for paid plan runs (2026-10-30): 30 validated requests
 * per IP per 10 minutes; only requests that would spend money count
 * (the check runs after validation, before any model wiring). A
 * blocked caller gets 429 with Retry-After. Per-instance memory:
 * see rateLimit.ts.
 */
const planRateLimiter = createRateLimiter(
  RATE_LIMIT_REQUESTS,
  RATE_LIMIT_WINDOW_MS,
);

const NDJSON = { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" };

function line(status: PlanJobStatus): string {
  return `${JSON.stringify(status)}\n`;
}

function failedLine(step: Exclude<PlanStep, "done">, message: string): Response {
  return new Response(line({ state: "failed", step, message }), { headers: NDJSON });
}

function isAbort(err: unknown): boolean {
  return (
    (err instanceof Error && err.name === "AbortError") ||
    (typeof err === "object" &&
      err !== null &&
      (err as { name?: unknown }).name === "AbortError")
  );
}

export async function POST(req: Request): Promise<Response> {
  // Handler start for runPlan's picturing time-limit skip: the 300 s
  // host limit counts from invocation, so the elapsed time must
  // include the body read and validation below, not just the
  // pipeline's own start.
  const handlerStartedAtMs = Date.now();
  // Access-code entitlement, before the body is read (see the header
  // note): when billing is off, checkEntitlement answers "off" and
  // this is a no-op, so the request proceeds exactly as before. A
  // failed check is a JSON error, like the other pre-stream errors
  // (400/413/429); "unavailable" is a 503 because Stripe could not
  // be reached, so the caller retries instead of reading the 402 as
  // a dead code.
  const accessCode = req.headers.get("x-sightwork-access-code");
  // Hoisted out of the block below so the done line can record the
  // finished plan against its pack (2026-11-13).
  let entitlement: Entitlement | undefined;
  if (accessCode) {
    entitlement = await checkEntitlement(accessCode);
    if (!entitlement.allowed && entitlement.reason !== "off") {
      // A denied code leaves a server-log trace (reason only, never the
      // code): a tampered code, an exhausted pack, or a Stripe outage
      // is otherwise invisible — the 402/503 alone says nothing about
      // how often paid runs are refused. Same JSON-event shape as the
      // pack-use log below.
      console.log(
        JSON.stringify({ event: "sightwork_entitlement_denied", reason: entitlement.reason }),
      );
      return new Response(
        JSON.stringify({
          error:
            entitlement.reason === "unavailable"
              ? "We can't check your plan right now. Try again shortly."
              : "That access code isn't active.",
          // The client maps reason "used-up" to the pack-used-up text on
          // screen (2026-11-13); any other 402 keeps the inactive-code text.
          ...(entitlement.reason === "used-up" ? { reason: "used-up" } : {}),
        }),
        {
          status: entitlement.reason === "unavailable" ? 503 : 402,
          headers: { "Content-Type": "application/json" },
        },
      );
    }
  }
  let bodyText: string;
  try {
    bodyText = await req.text();
  } catch {
    // JSON {error} (not plain text) so the client can surface this
    // message on a non-OK response instead of only its generic one.
    return new Response(JSON.stringify({ error: "could not read request body" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Agreed cap: the browser builder stays under 9 MB; over 10 MB the
  // client shows its own too-large message from the 413.
  if (planBodyTooLarge(bodyText)) {
    // JSON {error} (not plain text) so the client can surface this
    // message on a non-OK response; the client still keys its
    // too-large message off the 413 status, so this changes no UI yet.
    return new Response(JSON.stringify({ error: "plan request body too large" }), {
      status: 413,
      headers: { "Content-Type": "application/json" },
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return failedLine("uploading", "We couldn't read that plan request. Try again.");
  }

  const problems = validatePlanRequest(parsed);
  if (problems.length > 0) {
    console.error(`plan route: invalid request: ${problems.join("; ")}`);
    return failedLine("uploading", "That plan request was incomplete. Try again.");
  }
  const request = parsed as PlanRequest;

  // Rate limit after validation, before any model wiring: only a
  // request that would spend money counts against the bucket.
  const planLimit = planRateLimiter.check(clientIp(req));
  if (!planLimit.allowed) {
    return new Response(
      JSON.stringify({ error: "Too many plan requests. Try again shortly." }),
      {
        status: 429,
        headers: {
          "Content-Type": "application/json",
          "Retry-After": String(planLimit.retryAfterSec),
        },
      },
    );
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const push = (status: PlanJobStatus): void => {
        controller.enqueue(encoder.encode(line(status)));
      };
      push({ state: "running", step: "uploading" });
      // Uploading check (2026-10-30): the request is already validated,
      // so the frame count is the check — one more running line for the
      // same step, as runPlan does for its steps. Sharp swaps are
      // browser-side only and are not in the request, so the note is
      // the count alone, matching stepChecksForPlan on the finished plan.
      push({ state: "running", step: "uploading", check: uploadCheck(request.frames.length) });

      let tracker: ReturnType<typeof createUsageTracker> | undefined;
      let wired = false;
      try {
        // Every caller throws here when no key is configured, so a
        // keyless deploy fails fast on "uploading", before any step.
        const meta = createMetaClient();
        tracker = createUsageTracker();
        const provider = resolvePlanProvider();
        const segmentConcurrency = resolveSegmentConcurrency();
        const reasonCaller =
          provider === "baseten"
            ? createReasonBasetenCaller(createBasetenClient())
            : createReasonSparkCaller(meta);
        const deps = {
          transcribe: { callTranscribe: createAsrTranscribeCaller(), tracker },
          segment: { callSegment: createSamSegmentCaller(), tracker },
          reason: {
            prompt: REASON_PROMPT_TEMPLATE,
            schema: REASON_SCHEMA,
            callSpark: reasonCaller,
            tracker,
          },
          cost: {
            prompt: COST_PROMPT_TEMPLATE,
            schema: COST_SCHEMA,
            callSpark: createCostSparkCaller(meta),
            tracker,
          },
          renderAfter: { imageModel: IMAGE_MODEL, callImage: createImageCaller(), tracker },
          reasonPrompt: buildReasonPrompt,
          costPrompt: buildCostPrompt,
          // Reviewing (prompt 06, 2026-10-30): the reviewer runs on the
          // same provider caller as the reason step (Baseten Muse Spark
          // Open in baseten mode, Meta Muse Spark in meta mode) with
          // the buildReviewPrompt builder, so a finished plan
          // carries plan.review. Reviewing never fails a run: runPlan
          // ships ran:false on any review failure. Slow-run guard
          // (2026-11-03: a live run was cut at 312 s before picturing):
          // runPlan skips picturing and reviewing once the run is past
          // ~230 s from the handler start passed below, so a slow run
          // still ships a plan inside maxDuration; the stop signal IS
          // plumbed (2026-11-01: every pipeline leg, segment
          // included, forwards deps.signal to its model calls, and
          // runPlan rethrows aborts as a stop, not a step failure).
          review: { callSpark: reasonCaller },
          reviewPrompt: buildReviewPrompt,
        };
        wired = true;
        const plan = await runPlan(request, {
          ...deps,
          tracker,
          planProvider: provider,
          segmentConcurrency,
          // Baseten reason cap (2026-10-27): the
          // reason step takes at most 8 images in baseten mode;
          // runPlan subsets and remaps. Meta mode is untouched.
          reasonMaxFrames: provider === "baseten" ? REASON_MAX_FRAMES : undefined,
          onStatus: (status) => push(status),
          signal: req.signal,
          startedAtMs: handlerStartedAtMs,
        });
        push({ state: "done", plan });
        // Pack tally (2026-11-13): a finished plan counts against its
        // pack. Best-effort: the plan is already built, so a
        // bookkeeping failure is logged server-side and never fails
        // the run. A success is logged too, with the new count, so
        // pack usage is auditable from the server log without a
        // separate Stripe read.
        if (entitlement?.allowed && entitlement.kind === "pack") {
          const r = await recordPackUse(entitlement.stripeId);
          console.log(
            JSON.stringify(
              r.ok
                ? { event: "sightwork_pack_use", customer: entitlement.stripeId, used: r.used }
                : { event: "sightwork_pack_use_failed", reason: r.reason },
            ),
          );
        } else if (entitlement?.allowed && entitlement.kind === "sub") {
          // Sub use (2026-11-13): a subscription has no tally to
          // record, but a finished plan on a sub code still logs its
          // use, so a subscriber's completed plans are auditable
          // from the server log without a separate Stripe read —
          // the same gap the pack tally log closed. No Stripe write.
          console.log(
            JSON.stringify({ event: "sightwork_sub_use", customer: entitlement.stripeId }),
          );
        }
        console.log(
          `plan route: done, provider ${plan.meta?.planProvider ?? "unset"}, ` +
            `skipped ${JSON.stringify(plan.meta?.skipped ?? {})}, ` +
            `spike total $${tracker.totals().spikeTotalUsd}, ` +
            `${tracker.records().length} calls: ` +
            tracker
              .records()
              .map((r) => `${r.model}/${r.step} $${r.costUsd} ${r.latencyMs}ms`)
              .join(", ") +
            `; per-model ` +
            tracker
              .totalsByModel()
              .map((m) => `${m.model}: ${m.calls} calls $${m.totalUsd}`)
              .join(", "),
        );
      } catch (err) {
        // A failed run still spent model calls: log the partial usage
        // so spike tracking has real data even when no plan comes back.
        if (tracker) {
          console.error(
            `plan route: failed after ${tracker.records().length} calls, ` +
              `spike total $${tracker.totals().spikeTotalUsd}: ` +
              tracker
                .records()
                .map((r) => `${r.model}/${r.step} $${r.costUsd} ${r.latencyMs}ms`)
                .join(", ") +
              `; per-model ` +
              tracker
                .totalsByModel()
                .map((m) => `${m.model}: ${m.calls} calls $${m.totalUsd}`)
                .join(", "),
          );
        }
        // A failed run may already have billed calls (e.g. a billed
        // transcribe before a failed reason step): carry that total on
        // the failed line when it is positive, so the client keeps the
        // run-cost line instead of dropping the spend. Omit it when
        // nothing billed, keeping zero-cost failures byte-identical.
        const failedCostUsd =
          tracker && tracker.totals().spikeTotalUsd > 0
            ? tracker.totals().spikeTotalUsd
            : undefined;
        const costField = failedCostUsd !== undefined ? { costUsd: failedCostUsd } : {};
        if (isAbort(err)) {
          // Client went away; nothing left to stream.
        } else if (err instanceof PlanStepError) {
          if (err.detail) console.error(`plan route: ${err.step} failed: ${err.detail}`);
          push({ state: "failed", step: err.step, message: err.message, ...costField });
        } else if (!wired) {
          // Wiring failed (no key, or a caller could not be built).
          console.error(
            `plan route: wiring failed: ${err instanceof Error ? err.message : String(err)}`,
          );
          push({
            state: "failed",
            step: "uploading",
            message: "The plan service isn't set up yet. Try the example plan.",
            ...costField,
          });
        } else {
          console.error(
            `plan route: unexpected failure: ${err instanceof Error ? err.message : String(err)}`,
          );
          push({
            state: "failed",
            step: "planning",
            message: "Building the work plan failed. Try again.",
            ...costField,
          });
        }
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, { headers: NDJSON });
}
