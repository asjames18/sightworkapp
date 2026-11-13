import { RUN_STEPS, type PlanJobStatus, type PlanRequest, type RunStep, type WorkPlan } from "@/lib/types";
import { parseReview } from "@/lib/review";
import { parseStepCheck } from "@/lib/stepChecks";
import type { PlanJobRunner } from "./planJob";
import { BuildRequestError } from "./buildPlanRequest";
import { NARRATION_CHUNK_MAX_SEC, splitNarrationWav, stitchChunkTranscripts, type ChunkTranscript } from "./narrationChunks";
import { loadTestCode, TEST_CODE_HEADER } from "./testCode";
import { ACCESS_CODE_HEADER, loadAccessCode } from "./accessCode";
import { loadRegion } from "./location";
import { withRunRegion } from "./planText";

/**
 * Turns the picked video into the request body (frames + narration).
 * Runs in the browser; kept separate so the runner stays a thin transport.
 */
export type BuildPlanRequest = (file: File, signal: AbortSignal) => Promise<PlanRequest>;

const GENERIC_FAIL = "Something went wrong while making the plan. Try again, or open the example plan.";
const READ_FAIL = "We couldn't read that video. Try a different file, or open the example plan.";
const CONNECTION_FAIL = "The connection dropped before the plan finished. Try again.";

/**
 * The host stops a run at 5 minutes. A run whose stream is cut at about that mark ran out of time rather than
 * lost its connection, so say that and what helps (a shorter walkthrough) instead of a bare "dropped".
 */
export const TIME_LIMIT_FAIL = "This run hit the 5-minute limit before it finished. Try again, or film a shorter walkthrough.";
export const RUN_LIMIT_SEC = 280;
/** True for the message above, so a retry can go lighter (fewer, smaller frames) when the last run ran out of time. */
export function isTimeLimitFailure(message: string | undefined): boolean {
  return message === TIME_LIMIT_FAIL;
}

/**
 * The narration couldn't go on its own to /api/transcribe, and carrying it in the plan request would put
 * that request over the host's body cap (a platform 413 that reads as "too large"). Trying again usually works.
 */
export const NARRATION_SEND_FAIL = "We couldn't send what you said in the video. Try again in a moment.";

function isRunStep(v: unknown): v is RunStep {
  return typeof v === "string" && (RUN_STEPS as string[]).includes(v);
}

/**
 * Checks one streamed line against PlanJobStatus. Returns null for anything that
 * doesn't fit, so a bad line is skipped instead of breaking the screen.
 */
export function parseStatusLine(line: string): PlanJobStatus | null {
  const text = line.trim();
  if (!text) return null;
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (o.state === "running" && isRunStep(o.step)) {
    // "reviewing" is a run step but never an optional skip.
    const skipped = Array.isArray(o.skipped) ? o.skipped.filter((s): s is Exclude<RunStep, "reviewing"> => isRunStep(s) && s !== "reviewing") : [];
    const check = parseStepCheck(o.check);
    return { state: "running", step: o.step, ...(skipped.length ? { skipped } : {}), ...(check ? { check } : {}) };
  }
  if (o.state === "failed" && isRunStep(o.step)) {
    // What the run billed before it stopped, kept only when it's a real amount (see failureCostUsd).
    const costUsd = failureCostUsd(o);
    return {
      state: "failed",
      step: o.step,
      message: typeof o.message === "string" && o.message ? o.message : GENERIC_FAIL,
      ...(costUsd > 0 ? { costUsd } : {}),
    };
  }
  if (o.state === "done" && o.plan && typeof o.plan === "object") {
    const plan = o.plan as WorkPlan;
    // The review is advisory: a malformed one is dropped (the plan shows without it), never trusted as-is.
    if ("review" in plan) {
      const review = Array.isArray(plan.issues) ? parseReview(plan.review, plan.issues) : undefined;
      const { review: _r, ...rest } = plan;
      void _r;
      return { state: "done", plan: review ? { ...rest, review } : rest };
    }
    return { state: "done", plan };
  }
  return null;
}

/**
 * Screen text for a non-OK /api/plan response, keyed by status. The server's own
 * {error} text is written for developers, so it goes to the console, not the screen.
 */
/** The 401 text. The flow matches it to offer the tester-code prompt again with the same video. */
export const TESTER_CODE_MESSAGE = "Real runs need a tester code. Enter it to run this video, or open the example plan.";

/** A code was sent and the server refused it (typo, or the code was changed). Also reopens the prompt. */
export const WRONG_CODE_MESSAGE = "That tester code wasn't accepted. Check it and enter it again, or open the example plan.";

/** True for either tester-code failure, so the flow can offer the code prompt with the same video. */
export function isTesterCodeFailure(message: string): boolean {
  return message === TESTER_CODE_MESSAGE || message === WRONG_CODE_MESSAGE;
}

/**
 * A real run needs the city and state (Antonio, 2026-10-30): the upload screen asks for them on the video
 * card, so this only shows if storage was cleared mid-run. The flow reopens the card with the same video.
 */
export const LOCATION_REQUIRED_MESSAGE = "Add the city and state where this space is to make a plan from this video.";

/** True when the flow should go back to the video card with the same video (a code, a way to pay, or city/state). */
export function isResumeFailure(message: string): boolean {
  return isTesterCodeFailure(message) || isPaidRefusal(message) || message === LOCATION_REQUIRED_MESSAGE;
}

/** A paid access code the server refused (used up, canceled or changed). Not a tester-code failure. */
export const ACCESS_CODE_MESSAGE =
  "Your access code isn't active. Check your plan on the pricing page, or open the example plan.";

/** A plan pack code whose plans are all used: the server's 402 says reason "used-up". */
export const USED_UP_MESSAGE =
  "This plan pack is used up. Buy more plans on the pricing page, add your own key in Settings, or open the example plan.";

/** True when a refusal (402) body says the pack is used up. Reads a clone, so the original body stays unread. */
async function isUsedUp(res: Response): Promise<boolean> {
  try {
    const v: unknown = await res.clone().json();
    return !!v && typeof v === "object" && (v as { reason?: unknown }).reason === "used-up";
  } catch {
    return false;
  }
}

/** A 402 with no access code sent: billing is on, so a tester code alone no longer opens a real run. */
export const PAID_PLAN_MESSAGE =
  "Real runs need a paid plan. Get one on the pricing page, add your own key in Settings, or open the example plan.";

export function messageForStatus(status: number): string {
  if (status === 401) return TESTER_CODE_MESSAGE;
  if (status === 402) return ACCESS_CODE_MESSAGE;
  if (status === 413) return "That video is too large to send. Try a shorter walkthrough.";
  if (status === 400) return "The video's frames didn't come through right. Try again, or open the example plan.";
  if (status === 429) return "Too many plans are running right now. Wait a minute and try again.";
  if (status === 504) return "The plan took too long to finish. Try a shorter walkthrough, or open the example plan.";
  return GENERIC_FAIL;
}

/**
 * What a failed request's model calls cost, from a JSON body's costUsd (the transcribe route sends it on a
 * 500 when a billed call failed). 0 for anything else, so it can only ever add a real amount.
 */
export function failureCostUsd(v: unknown): number {
  if (!v || typeof v !== "object") return 0;
  const usd = (v as { costUsd?: unknown }).costUsd;
  return typeof usd === "number" && Number.isFinite(usd) && usd > 0 ? usd : 0;
}

/**
 * Reads a JSON {error} (or short plain text) from a non-OK response and logs it. Never throws.
 * Returns the body's costUsd (see failureCostUsd), 0 when there is none.
 */
async function logServerError(res: Response, what = "plan"): Promise<number> {
  let costUsd = 0;
  try {
    const text = (await res.text()).slice(0, 500);
    let detail = text;
    try {
      const v: unknown = JSON.parse(text);
      costUsd = failureCostUsd(v);
      if (v && typeof v === "object" && typeof (v as { error?: unknown }).error === "string")
        detail = (v as { error: string }).error;
    } catch {
      /* plain text body */
    }
    console.warn(`${what} request failed: HTTP ${res.status}${detail ? `: ${detail}` : ""}`);
  } catch {
    /* body unreadable; the status is enough */
  }
  return costUsd;
}

/**
 * Shape POST /api/transcribe answers with (TranscribeOutput), plus costUsd: what that request's model
 * calls cost. costUsd is 0 when the server sent none or a bad value, so it can only ever add a real amount.
 */
type TranscribeAnswer = { transcript: string | null; transcriptTurns: NonNullable<PlanRequest["transcriptTurns"]>; costUsd: number };

function isTurn(v: unknown): boolean {
  if (!v || typeof v !== "object") return false;
  const t = v as Record<string, unknown>;
  return typeof t.startSec === "number" && Number.isFinite(t.startSec) && typeof t.text === "string";
}

/** Checks a /api/transcribe body. A blank transcript counts as no narration (null), which /api/plan accepts. */
export function parseTranscribeAnswer(v: unknown): TranscribeAnswer | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (o.transcript !== null && typeof o.transcript !== "string") return null;
  const turns = o.transcriptTurns === undefined ? [] : o.transcriptTurns;
  if (!Array.isArray(turns) || !turns.every(isTurn)) return null;
  const transcript = typeof o.transcript === "string" && o.transcript.trim() ? o.transcript : null;
  const costUsd = typeof o.costUsd === "number" && Number.isFinite(o.costUsd) && o.costUsd > 0 ? o.costUsd : 0;
  return { transcript, transcriptTurns: transcript ? (turns as TranscribeAnswer["transcriptTurns"]) : [], costUsd };
}

/**
 * Adds the split transcribe request's cost to the plan's own model-call total, so the run-cost line covers
 * the whole run. Only when the plan carries a usable total: a plan without one stays without one (adding
 * just the transcribe part would show a much smaller number than the run really cost).
 */
export function withTranscribeCost(plan: WorkPlan, transcribeUsd: number): WorkPlan {
  const usd = plan.meta?.costUsd;
  if (!(transcribeUsd > 0) || !Number.isFinite(transcribeUsd)) return plan;
  if (typeof usd !== "number" || !Number.isFinite(usd) || usd < 0) return plan;
  return { ...plan, meta: { ...plan.meta, costUsd: Math.round((usd + transcribeUsd) * 1e6) / 1e6 } };
}

/**
 * Adds the split transcribe request's cost to a failed line, so "what this run cost" covers the whole run
 * even when it stopped. A line with no amount gets the transcribe cost alone (that much was surely billed);
 * nothing billed leaves the line without costUsd.
 */
export function withFailureCost(s: Extract<PlanJobStatus, { state: "failed" }>, extraUsd: number): Extract<PlanJobStatus, { state: "failed" }> {
  const base = failureCostUsd(s);
  const extra = Number.isFinite(extraUsd) && extraUsd > 0 ? extraUsd : 0;
  const { costUsd: _c, ...rest } = s;
  void _c;
  const total = Math.round((base + extra) * 1e6) / 1e6;
  return total > 0 ? { ...rest, costUsd: total } : rest;
}

type TranscribeTry = { ok: true; answer: TranscribeAnswer } | { ok: false; unauthorized: boolean; refused?: "inactive" | "used-up"; costUsd: number };

/** Who is asking: a tester code alone (string), or the tester and/or paid access code headers. */
export type TranscribeAuth = string | { testCode?: string | null; accessCode?: string | null };

function authHeaders(auth: TranscribeAuth): Record<string, string> {
  if (typeof auth === "string") return { [TEST_CODE_HEADER]: auth };
  return {
    ...(auth.testCode ? { [TEST_CODE_HEADER]: auth.testCode } : {}),
    ...(auth.accessCode ? { [ACCESS_CODE_HEADER]: auth.accessCode } : {}),
  };
}

/** One POST /api/transcribe. Never throws: a dropped connection or an unreadable answer is { ok: false }. */
async function postTranscribe(endpoint: string, wavBase64: string, spaceType: string | undefined, code: TranscribeAuth, signal: AbortSignal): Promise<TranscribeTry> {
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders(code) },
      body: JSON.stringify(spaceType ? { audioWavBase64: wavBase64, spaceType } : { audioWavBase64: wavBase64 }),
      signal,
    });
    if (res.status === 401) return { ok: false, unauthorized: true, costUsd: 0 };
    // A paid access code that isn't active: no point sending the plan request, it would be refused too.
    if (res.status === 402) return { ok: false, unauthorized: false, refused: (await isUsedUp(res)) ? "used-up" : "inactive", costUsd: 0 };
    // A billed transcribe call that then failed still cost something; keep it in the run's total.
    if (!res.ok) return { ok: false, unauthorized: false, costUsd: await logServerError(res, "transcribe") };
    const answer = parseTranscribeAnswer(await res.json());
    return answer ? { ok: true, answer } : { ok: false, unauthorized: false, costUsd: 0 };
  } catch {
    return { ok: false, unauthorized: false, costUsd: 0 };
  }
}

/**
 * Option (b) for the 4.5 MB body cap: when the request carries narration, POST it alone to
 * /api/transcribe first and send the plan request with the transcript instead of the WAV.
 * Narration longer than chunkMaxSec (long room-size takes) is cut into chunks at quiet points and sent
 * one chunk per request, then joined with each chunk's turn times shifted to take time (narrationChunks.ts);
 * a failed chunk is tried once more, and silent chunks aren't sent.
 * Returns the request to send, "unauthorized" on 401, or "refused" / "used-up" on 402 (an access code that isn't active, or a pack with no plans left). Any other failure keeps the original
 * WAV-carrying request, so narration is never silently dropped (same behavior as before the split),
 * along with what the failed transcribe requests cost when the server says so.
 */
export async function splitNarration(
  body: PlanRequest,
  endpoint: string,
  code: TranscribeAuth,
  signal: AbortSignal,
  chunkMaxSec: number = NARRATION_CHUNK_MAX_SEC,
  /**
   * Called once before any narration is sent: with no part when it goes in one piece, then with
   * { at, of } before each chunk of a long narration (silent chunks are counted but not sent).
   */
  onSending?: (part?: { at: number; of: number }) => void,
): Promise<{ body: PlanRequest; costUsd: number } | "unauthorized" | "refused" | "used-up"> {
  const keep = { body, costUsd: 0 };
  if (!body.audioWavBase64 || body.transcript !== undefined) return keep;
  const withTranscript = (t: { transcript: string | null; transcriptTurns: TranscribeAnswer["transcriptTurns"] }, costUsd: number) => {
    const { audioWavBase64: _wav, ...rest } = body;
    void _wav;
    return { body: { ...rest, transcript: t.transcript, transcriptTurns: t.transcriptTurns }, costUsd };
  };
  const chunks = splitNarrationWav(body.audioWavBase64, chunkMaxSec);
  if (!chunks) {
    onSending?.();
    const one = await postTranscribe(endpoint, body.audioWavBase64, body.spaceType, code, signal);
    if (one.ok) return withTranscript(one.answer, one.answer.costUsd);
    if (one.refused) return one.refused === "used-up" ? "used-up" : "refused";
    return one.unauthorized ? "unauthorized" : { body, costUsd: one.costUsd };
  }
  let costUsd = 0;
  const parts: ChunkTranscript[] = [];
  for (const [i, chunk] of chunks.entries()) {
    if (chunk.silent) {
      parts.push({ offsetSec: chunk.startSec, transcript: null, transcriptTurns: [] });
      continue;
    }
    let got: TranscribeTry | null = null;
    if (!signal.aborted) onSending?.({ at: i + 1, of: chunks.length });
    for (let attempt = 0; attempt < 2; attempt++) {
      if (signal.aborted) return { body, costUsd };
      got = await postTranscribe(endpoint, chunk.wavBase64, body.spaceType, code, signal);
      if (got.ok) break;
      costUsd += got.costUsd;
      if (got.unauthorized) return "unauthorized";
      if (got.refused) return got.refused === "used-up" ? "used-up" : "refused";
    }
    if (!got || !got.ok) return { body, costUsd: Math.round(costUsd * 1e6) / 1e6 };
    costUsd += got.answer.costUsd;
    parts.push({ offsetSec: chunk.startSec, transcript: got.answer.transcript, transcriptTurns: got.answer.transcriptTurns });
  }
  return withTranscript(stitchChunkTranscripts(parts), Math.round(costUsd * 1e6) / 1e6);
}

/**
 * Real runner for POST /api/plan. The server streams newline-delimited JSON, one
 * PlanJobStatus per line; the last line is done or failed. Aborting the signal
 * cancels the request, and the server stops its work on disconnect.
 * With narration, POST /api/transcribe runs first (pass null to skip that split).
 */
export function createApiPlanJob(
  buildRequest: BuildPlanRequest,
  endpoint = "/api/plan",
  transcribeEndpoint: string | null = "/api/transcribe",
  /** Host body cap for the plan request; a WAV-carrying fallback over it stops with NARRATION_SEND_FAIL. */
  maxBodyBytes?: number,
  /** Longest narration chunk per /api/transcribe request (see narrationChunkMaxSec). */
  narrationChunkSec: number = NARRATION_CHUNK_MAX_SEC,
  /** Clock for the run-length check (milliseconds). Tests pass their own. */
  now: () => number = Date.now,
): PlanJobRunner {
  return async ({ file, onStatus, signal }) => {
    let lastStep: RunStep = "uploading";
    const report = (s: PlanJobStatus) => {
      if (signal.aborted) return;
      if (s.state !== "done") lastStep = s.step;
      onStatus(s);
    };
    // What the split transcribe request cost, carried on any failure after it so the Stopped screen can say
    // what the run billed.
    let transcribeUsd = 0;
    const fail = (message: string) => report(withFailureCost({ state: "failed", step: lastStep, message }, transcribeUsd));
    // The plan request got through and was running when the stream was cut: its spend is not known here, and a
    // cut that late is the host's time limit, not a lost signal.
    let planStartedAt = 0;
    const failCut = () => {
      const base = withFailureCost(
        {
          state: "failed",
          step: lastStep,
          message: planStartedAt && now() - planStartedAt >= RUN_LIMIT_SEC * 1000 ? TIME_LIMIT_FAIL : CONNECTION_FAIL,
        },
        transcribeUsd,
      );
      report(planStartedAt ? { ...base, costPartial: true } : base);
    };

    report({ state: "running", step: "uploading" });

    // The server answers 401 to any run without a tester code (src/proxy.ts), so don't spend the time
    // reading frames and audio and uploading megabytes just to hear that.
    // A paid access code (saved after a purchase) also opens a real run; the plan route checks it.
    const testCode = loadTestCode();
    const accessCode = loadAccessCode();
    if (!testCode && !accessCode) {
      fail(messageForStatus(401));
      return;
    }

    // City and state are required for a real run (the cost step prices for them); checked before any work.
    const region = loadRegion();
    if (!region) {
      fail(LOCATION_REQUIRED_MESSAGE);
      return;
    }

    let body: PlanRequest;
    try {
      body = await buildRequest(file, signal);
      // The saved "City, ST" rides on every real run as PlanRequest.region, unless the builder set one.
      if (!body.region?.trim()) body = { ...body, region };
    } catch (err) {
      // A BuildRequestError says what's wrong with this video (too long, no picture, blank); show it.
      if (!signal.aborted) fail(err instanceof BuildRequestError ? err.message : READ_FAIL);
      return;
    }
    if (signal.aborted) return;

    // The split /api/transcribe request's cost (transcribeUsd above) is added to the plan's total when it comes back.
    // The split transcribe request carries the same codes as the plan request (tester code, paid access code, or both).
    if (transcribeEndpoint) {
      // The processing screen moves to "Listening" while the narration is read, with "part 2 of 4" on long takes.
      const split = await splitNarration(body, transcribeEndpoint, { testCode, accessCode }, signal, narrationChunkSec, (part) =>
        report(part ? { state: "running", step: "listening", part } : { state: "running", step: "listening" }),
      );
      if (signal.aborted) return;
      if (split === "unauthorized") {
        fail(testCode ? WRONG_CODE_MESSAGE : messageForStatus(401));
        return;
      }
      if (split === "used-up") {
        fail(USED_UP_MESSAGE);
        return;
      }
      if (split === "refused") {
        fail(accessCode ? messageForStatus(402) : PAID_PLAN_MESSAGE);
        return;
      }
      body = split.body;
      transcribeUsd = split.costUsd;
    }
    // Frames sized for a split run (see narrationSentSeparately) plus the WAV would not fit; say so plainly.
    if (body.audioWavBase64 && maxBodyBytes && JSON.stringify(body).length > maxBodyBytes) {
      fail(NARRATION_SEND_FAIL);
      return;
    }

    let res: Response;
    const startedAt = now();
    try {
      res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/x-ndjson",
          ...(testCode ? { [TEST_CODE_HEADER]: testCode } : {}),
          ...(accessCode ? { [ACCESS_CODE_HEADER]: accessCode } : {}),
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch {
      if (!signal.aborted) fail(CONNECTION_FAIL);
      return;
    }
    if (!res.ok || !res.body) {
      const usedUp = res.status === 402 && !!accessCode && (await isUsedUp(res));
      if (!res.ok) await logServerError(res);
      // A tester code was sent, so a 401 means the server refused it; with only an access code, a 401 means
      // the server isn't taking paid runs, and the tester-code prompt is the way in.
      fail(
        res.ok
          ? GENERIC_FAIL
          : res.status === 401 && testCode
            ? WRONG_CODE_MESSAGE
            : res.status === 402 && !accessCode
              ? PAID_PLAN_MESSAGE
              : usedUp
                ? USED_UP_MESSAGE
                : messageForStatus(res.status),
      );
      return;
    }

    planStartedAt = startedAt;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let finished = false;
    const handle = (line: string) => {
      const s = parseStatusLine(line);
      if (!s || finished) return;
      if (s.state !== "running") finished = true;
      // The plan keeps the City, ST it was run for, even when the cost step failed and costRange is null,
      // and its model-call total includes the split transcribe request.
      report(
        s.state === "done"
          ? { ...s, plan: withTranscribeCost(withRunRegion(s.plan, body.region), transcribeUsd) }
          : s.state === "failed"
            ? withFailureCost(s, transcribeUsd)
            : s,
      );
    };

    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          handle(buf.slice(0, nl));
          buf = buf.slice(nl + 1);
        }
        if (finished) break;
      }
      buf += decoder.decode();
      if (!finished && buf) handle(buf);
    } catch {
      if (!signal.aborted && !finished) failCut();
      return;
    } finally {
      reader.cancel().catch(() => {});
    }

    if (!finished && !signal.aborted) failCut();
  };
}

/**
 * True for a run the server refused for payment (402): no paid plan, an access code that isn't active, or a
 * used-up pack. The failure screen then links Pricing and the own-key Settings and offers the run choice again.
 */
export function isPaidRefusal(message: string): boolean {
  return message === PAID_PLAN_MESSAGE || message === ACCESS_CODE_MESSAGE || message === USED_UP_MESSAGE;
}
