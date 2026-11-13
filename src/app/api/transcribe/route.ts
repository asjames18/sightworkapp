/**
 * POST /api/transcribe: one narration WAV in, one transcript out.
 *
 * Option (b) for the Vercel 4.5 MB body cap (2026-10-29
 * 9:50 PM review): the browser calls this route first with the narration
 * alone, then sends the plan request carrying the transcript instead
 * of the WAV, so a 45-60 s narrated take no longer has to fit frames
 * plus audio inside one 4.5 MB plan request. The transcribe request
 * itself still carries the WAV, so it is still under the same
 * platform cap: 16 kHz mono WAV is ~32 KB/s raw, ~43 KB/s once
 * base64-encoded, so ~110 s of narration fits per request.
 * Narration over 80 s arrives as several requests of at most 80 s
 * each (cut at quiet points by the browser, one retry per piece),
 * so each request stays well under that limit; joining and
 * time-shifting stay client-only.
 *
 * Request (JSON): { audioWavBase64?: string, spaceType?: string } —
 * the same fields as TranscribeInput in src/lib/pipeline/transcribe.ts.
 * Omit audioWavBase64 (or send "") for no narration: no call is made
 * and the response is the empty transcript, without needing a key.
 * Response (JSON): the TranscribeOutput shape plus `costUsd` — this
 * request's tracker total in USD, so a split run's transcribe spend is
 * visible to the caller instead of living only in the server log (the
 * plan total counts only its own request's tracker, so a future client
 * change can carry this into the plan request). The empty-narration
 * response carries costUsd: 0. One "[t] text" line per turn.
 * Errors are JSON { error } with a plain message; the detail rides
 * on the server log only, like the plan route's failed lines.
 *
 * Wiring mirrors the plan route's transcribe deps (Meta ASR caller,
 * per-request usage tracker enforcing the $10 spike cap in code).
 * Like the plan route, this route logs a per-model usage summary on
 * done and on failure: a split run's transcribe call is a separate
 * request from the plan request, so without this line its cost would
 * be invisible to spike tracking and a double transcribe (browser
 * call + plan re-transcribe) would not show up in the server log.
 * The plan route does not pass a cleanup prompt, so neither does
 * this route: raw turns are returned as-is. No call happens on
 * import, and the key is read from process.env only by the caller.
 *
 * Body cap: the route rejects bodies over MAX_TRANSCRIBE_BODY_BYTES
 * with a 413 before JSON.parse, mirroring the plan route's 10 MB cap.
 * The cap covers the largest audio the transcribe step accepts
 * (32 MB decoded, src/lib/pipeline/transcribe.ts) once base64-encoded,
 * plus JSON framing, so it rejects only bodies the step would reject
 * anyway — no valid request changes.
 *
 * Access-code entitlement (2026-11-13): the same gate as POST
 * /api/plan, at the top of POST before the body is read, so a paid
 * run's split transcribe call is not stuck behind the tester-code
 * gate on long narration. No pack tally here.
 */

import { checkEntitlement } from "../../../lib/billing/entitlement";
import { createAsrTranscribeCaller } from "../../../lib/meta/transcribe";
import {
  runTranscribe,
  validateTranscribeInput,
} from "../../../lib/pipeline/transcribe";
import { createUsageTracker } from "../../../lib/pipeline/usage";
import {
  RATE_LIMIT_REQUESTS,
  RATE_LIMIT_WINDOW_MS,
  clientIp,
  createRateLimiter,
} from "../../../lib/pipeline/rateLimit";

export const runtime = "nodejs";

// Explicit Vercel function duration: 300 s is the Hobby maximum and
// the Pro default, so this states the platform limit rather than
// raising it. A transcribe call is seconds, not minutes; time is not
// the binding limit on a hosted run, the 4.5 MB request-body cap is.
export const maxDuration = 300;

export const dynamic = "force-dynamic";

/**
 * Per-IP brake for paid transcribe runs (2026-10-30): 30 spending
 * requests per IP per 10 minutes, separate bucket from /api/plan.
 * The check runs after validation and after the free empty-audio
 * return, so only a request that would spend money counts.
 * Per-instance memory: see rateLimit.ts.
 */
const transcribeRateLimiter = createRateLimiter(
  RATE_LIMIT_REQUESTS,
  RATE_LIMIT_WINDOW_MS,
);

/**
 * Largest transcribe request body the route parses: base64 of the
 * 32 MB audio the transcribe step accepts, plus JSON framing.
 * 32 MB decoded encodes to ~44.74 MB; 46 MB leaves room for the
 * field names and spaceType while still rejecting, before JSON.parse,
 * any body the step would reject for size anyway.
 */
export const MAX_TRANSCRIBE_BODY_BYTES = 46 * 1024 * 1024;

/** True when the raw request body is over MAX_TRANSCRIBE_BODY_BYTES. */
export function transcribeBodyTooLarge(bodyText: string): boolean {
  return new TextEncoder().encode(bodyText).length > MAX_TRANSCRIBE_BODY_BYTES;
}

const JSON_HEADERS = { "Content-Type": "application/json" };

function errorResponse(message: string, status: number, extra?: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ error: message, ...extra }), {
    status,
    headers: JSON_HEADERS,
  });
}

export async function POST(req: Request): Promise<Response> {
  // Access-code entitlement (2026-11-13): the same gate as POST
  // /api/plan, at the top, so a paid run's split transcribe call is
  // not stuck behind the tester-code gate on long narration. No pack
  // tally here — the plan run records the use. When billing is off
  // the check is a no-op and the request proceeds exactly as before.
  // Note: the gate runs before the empty-audio return too, so a dead
  // code fails fast even on a no-narration request.
  const accessCode = req.headers.get("x-sightwork-access-code");
  if (accessCode) {
    const entitlement = await checkEntitlement(accessCode);
    if (!entitlement.allowed && entitlement.reason !== "off") {
      // A denied code leaves a server-log trace (reason only, never the
      // code): a tampered code, an exhausted pack, or a Stripe outage
      // is otherwise invisible — the 402/503 alone says nothing about
      // how often paid runs are refused. Same JSON-event shape as the
      // plan route's pack-use log.
      console.log(
        JSON.stringify({ event: "sightwork_entitlement_denied", reason: entitlement.reason }),
      );
      return errorResponse(
        entitlement.reason === "unavailable"
          ? "We can't check your plan right now. Try again shortly."
          : "That access code isn't active.",
        entitlement.reason === "unavailable" ? 503 : 402,
        // The client maps reason "used-up" to the pack-used-up text on
        // screen (2026-11-13); any other 402 keeps the inactive-code text.
        entitlement.reason === "used-up" ? { reason: "used-up" } : undefined,
      );
    }
  }
  let bodyText: string;
  try {
    bodyText = await req.text();
  } catch {
    return errorResponse("could not read transcribe request body", 400);
  }

  // Reject an oversize body before JSON.parse: a body over the cap
  // cannot be a valid request (the step caps audio at 32 MB decoded),
  // so the 413 changes no valid request, it just fails fast.
  if (transcribeBodyTooLarge(bodyText)) {
    return errorResponse("transcribe request body too large", 413);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return errorResponse("could not read transcribe request", 400);
  }

  try {
    validateTranscribeInput(parsed as { audioWavBase64?: string; spaceType?: string });
  } catch (err) {
    console.error(`transcribe route: invalid request: ${err instanceof Error ? err.message : String(err)}`);
    return errorResponse("That transcribe request was incomplete. Try again.", 400);
  }
  const input = parsed as { audioWavBase64?: string; spaceType?: string };

  // No narration means no call and no key needed: a keyless deploy
  // answers the empty transcript instead of failing on caller setup.
  if (!input.audioWavBase64) {
    return new Response(JSON.stringify({ transcript: null, transcriptTurns: [], costUsd: 0 }), {
      headers: JSON_HEADERS,
    });
  }

  // Tracker lives outside the try so a failed run still logs its
  // partial usage (including zero calls on a wiring failure, which
  // proves the failure spent nothing) — same pattern as the plan
  // route's failed-run line.
  // Rate limit after validation and after the free empty-audio return:
  // only a request that would spend money counts against the bucket.
  const transcribeLimit = transcribeRateLimiter.check(clientIp(req));
  if (!transcribeLimit.allowed) {
    return new Response(
      JSON.stringify({ error: "Too many transcribe requests. Try again shortly." }),
      {
        status: 429,
        headers: {
          ...JSON_HEADERS,
          "Retry-After": String(transcribeLimit.retryAfterSec),
        },
      },
    );
  }

  const tracker = createUsageTracker();
  try {
    const out = await runTranscribe(input, {
      callTranscribe: createAsrTranscribeCaller(),
      tracker,
      // A stopped split run stops its in-flight ASR call instead of
      // billing it to completion: the plan route already hands its
      // request signal to runPlan's transcribe deps (2026-11-01),
      // but this standalone route never passed one, so a client
      // that went away still paid for the whole ASR call.
      signal: req.signal,
    });
    console.log(
      `transcribe route: done, spike total $${tracker.totals().spikeTotalUsd}, ` +
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
    return new Response(
      JSON.stringify({ ...out, costUsd: tracker.totals().spikeTotalUsd }),
      { headers: JSON_HEADERS },
    );
  } catch (err) {
    console.error(
      `transcribe route: failed after ${tracker.records().length} calls, ` +
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
    console.error(`transcribe route: ${err instanceof Error ? err.message : String(err)}`);
    // Parity with the success path (and the 7:45 AM costUsd change):
    // a billed ASR failure is already recorded on the tracker by the
    // transcribe step's recordFailedCall, so the 500 carries the same
    // costUsd instead of leaving the split caller to find the spend
    // only in the server log. An unpriceable failure still reports
    // costUsd: 0, matching the empty-narration answer.
    return new Response(
      JSON.stringify({
        error: "We couldn't transcribe that narration. Try again.",
        costUsd: tracker.totals().spikeTotalUsd,
      }),
      { status: 500, headers: JSON_HEADERS },
    );
  }
}
