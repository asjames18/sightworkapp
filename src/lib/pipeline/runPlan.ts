/**
 * SightWork pipeline runner: one PlanRequest in, one WorkPlan out.
 *
 * Stage order, matched to the UI steps in types.ts:
 *   listening (transcribe) -> looking + counting (segment) ->
 *   comparing (reason) -> planning (cost + assembly) ->
 *   picturing (renderAfter) -> reviewing (review, optional).
 * Reviewing is review-only and never fails a run: it checks the
 * finished plan against its proof photos and lands on plan.review.
 * Transcribe is optional the same way: a failed transcribe call
 * continues without narration and sets meta.skipped.transcribe,
 * so a flaky ASR call costs the said-vs-seen part, not the plan.
 * The route emits the first "uploading" status itself, right after it
 * parses the body; this runner starts at "listening".
 *
 * The runner makes no Meta calls itself. Every model call goes through
 * a caller injected in the step deps, and every call is recorded on
 * the shared tracker, which enforces the spike cap in code.
 *
 * Failures throw PlanStepError: a pipeline step plus a plain message
 * (no provider error text, no model output), so the route can stream
 * it straight to the UI as { state: "failed", step, message }. The
 * internal detail rides on PlanStepError.detail for the server log
 * only, never for the UI. An aborted signal throws an AbortError
 * instead, so the route can just close the stream.
 *
 * Per-request prompt seam: prompts 03/05 carry per-request variables
 * (frames, transcript, region), so a static dep prompt cannot fill
 * them. The route may pass reasonPrompt / costPrompt builders on
 * RunPlanDeps instead; when present, the built prompt replaces the
 * static dep prompt for that run (including the reason retry, which
 * reuses the step prompt). When absent, the static prompt is used
 * unchanged. The seam lives here, not in the step deps, because this
 * runner already assembles both step inputs. The review prompt works
 * the same way: reviewPrompt builds prompt 06 from the finished plan
 * (its issues and selected proof photos), and the route supplies the
 * review caller alongside it.
 */

import {
  AFTER_IMAGE_LABEL,
  checkWorkPlan,
  type PlanFrame,
  type Issue,
  type PlanJobStatus,
  type PlanProvider,
  type PlanRequest,
  type PlanStep,
  type RunStep,
  type StepCheck,
  type WorkPlan,
} from "../types";
import { stepChecksForPlan, transcriptWords } from "../stepChecks";
import { estimateCost, type CostDeps, type CostInput } from "./cost";
import { MAX_PLAN_FRAMES } from "./planRequest";
import {
  runReason,
  formatReasonStability,
  type ReasonDeps,
  type ReasonInput,
  type ReasonOutput,
} from "./reason";
import { runRenderAfter, type RenderAfterDeps } from "./renderAfter";
import {
  MAX_REVIEW_IMAGES,
  REVIEW_SCHEMA,
  runReview,
  type ReviewSparkCaller,
} from "./review";
import { runSegment, type SegmentDeps } from "./segment";
import {
  MAX_AUDIO_BYTES,
  runTranscribe,
  type TranscribeDeps,
} from "./transcribe";
import type { UsageTracker } from "./usage";

/** A pipeline failure, mapped to the UI step that stopped. */
export class PlanStepError extends Error {
  step: Exclude<PlanStep, "done">;
  /** Internal detail for the server log only; never sent to the UI. */
  detail?: string;

  constructor(step: Exclude<PlanStep, "done">, message: string, detail?: string) {
    super(message);
    this.name = "PlanStepError";
    this.step = step;
    this.detail = detail;
  }
}

/** Plain failure message per step; the UI shows these as-is. */
export const PLAIN_FAILURE_MESSAGE: Record<Exclude<PlanStep, "done">, string> = {
  uploading: "Upload failed. Try again.",
  listening: "Listening failed. Try again with a clearer recording.",
  looking: "Looking at the frames failed. Try again.",
  counting: "Counting failed. Try again.",
  comparing: "Comparing what was said with what was seen failed. Try again.",
  planning: "Building the work plan failed. Try again.",
  picturing: "Picturing the finished space failed. Try again.",
};

export interface RunPlanDeps {
  transcribe: TranscribeDeps;
  segment: SegmentDeps;
  reason: ReasonDeps;
  cost: CostDeps;
  renderAfter: RenderAfterDeps;
  /**
   * Per-request prompt builders (see header). When present, the built
   * prompt replaces the static dep prompt for that run; otherwise the
   * static prompt is used. costPrompt is only called when the request
   * has a region, since estimateCost returns null without one.
   */
  reasonPrompt?: (input: ReasonInput) => string;
  costPrompt?: (input: CostInput, spaceType?: string) => string;
  /**
   * Reviewer step (prompt 06), optional: when both review and
   * reviewPrompt are given, runPlan runs the reviewing step after
   * picturing and attaches its result to plan.review; when both are
   * absent, the run ends at picturing with no review, as before.
   * Giving exactly one is a wiring bug and fails fast in
   * validateRunPlanDeps. The caller is the plan step's provider
   * caller (Baseten Muse Spark Open in baseten mode); the schema
   * defaults to REVIEW_SCHEMA and the tracker is the shared one, so
   * the review call counts against the spike cap like every step.
   * runReview never throws for a runtime failure, so reviewing
   * never fails a run: a failed review lands as ran:false.
   */
  review?: {
    callSpark: ReviewSparkCaller;
  };
  /**
   * Builds prompt 06 from the finished plan. Receives the plan's
   * issues in rank order and the selected proof photos in attach
   * order (Photo A, B, ...); the builder fills the prompt's photo
   * and problem lists from them, including each problem's own
   * photo letters and captions, and the schema placeholder.
   */
  reviewPrompt?: (input: ReviewPromptInput) => string;
  /** Shared with every step dep above; its totals land in plan.meta. */
  tracker: UsageTracker;
  /**
   * Which engine wrote the reason step (meta or baseten). Lands in
   * plan.meta alongside the cost total, so the plan itself names its
   * engine; omitted leaves meta.planProvider unset.
   */
  planProvider?: PlanProvider;
  /**
   * Cap on frames handed to the reason step (2026-10-27
   * 11:43 AM review: the Baseten reason call takes at most 8 images). The
   * route sets it in baseten mode only; the meta path is untouched.
   * When set, runPlan picks a subset (pickReasonFrames), the reason
   * step sees subset positions, and its output is remapped back to
   * plan frames (remapReasonOutput) before assembly. Unset means no
   * subsetting: the reason step sees every request frame.
   */
  reasonMaxFrames?: number;
  /**
   * SAM pool size for the segment step (segment.ts: at most this
   * many SAM calls in flight; default DEFAULT_SEGMENT_CONCURRENCY
   * when unset). The route may lower it under a tight spike budget
   * or raise it when latency matters; unset keeps runSegment's
   * own default, so existing callers are untouched.
   */
  segmentConcurrency?: number;
  /** Called with each running status, in stage order. When optional
   * steps were skipped earlier in the run, the status carries the
   * cumulative skipped list (2026-10-27 5:45 PM review: the
   * processing screen shows those steps as skipped this run); the
   * field is omitted when nothing was skipped. */
  onStatus?: (status: PlanJobStatus) => void;
  /** When aborted, the run stops with an AbortError. */
  signal?: AbortSignal;
  /**
   * Wall-clock ms when the run started (the route passes its handler
   * start, so the elapsed time counts against the host's function
   * limit, not just the pipeline's own start). When omitted, runPlan's
   * own start is used. Drives the picturing time-limit skip below.
   */
  startedAtMs?: number;
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    const err = new Error("runPlan: aborted");
    err.name = "AbortError";
    throw err;
  }
}

function isAbort(err: unknown): boolean {
  return (
    (err instanceof Error && err.name === "AbortError") ||
    (typeof err === "object" &&
      err !== null &&
      (err as { name?: unknown }).name === "AbortError")
  );
}

/**
 * True when a contract error was already reported as a reason warning.
 * Compared by field key (issues[0], heroFrameIndex, ...), not exact
 * text, because validateReason phrases frame errors with values while
 * checkWorkPlan phrases them without. A costRange error can never be
 * explained by a reason warning, so a new cost error still throws.
 */
function explainedByReasonWarnings(err: string, warnings: string[]): boolean {
  const key = (text: string): string => {
    const m = /^(issues\[\d+\]|workOrder\[\d+\]|inventory\[\d+\]|saidVsSeen\[\d+\])/.exec(text);
    if (m) return m[1];
    if (text.startsWith("heroFrameIndex")) return "heroFrameIndex";
    return text;
  };
  return warnings.some((w) => key(w) === key(err));
}

function detailOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * True when the error is a usage-tracker spike-cap throw. A cap breach
 * is a spending stop, not an optional-step failure: the run must fail
 * fast instead of continuing to later steps, each of which would spend
 * another call before its own tracker record throws.
 */
function isSpikeCapError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /spike cap/i.test(message);
}

/** Baseten reason-call image cap (2026-10-27 11:43 AM review). */
export const REASON_MAX_FRAMES = 8;

/**
 * Pick the subset of request frames handed to the reason step when it
 * is capped (Baseten mode). Evenly spaced across the walkthrough,
 * always including the first and last frame; any frame that holds a
 * hazard or mask hit (segmentation.flaggedFrames) is swapped in
 * before a plain frame, displacing the plain, non-endpoint subset
 * member nearest to it. First and last frames are never displaced.
 * A flagged frame is left out only when every subset member is
 * already an endpoint or a flagged frame. When zoneIds is given
 * (one entry per request frame, from PlanRequest.frames[].zoneId),
 * a zone pass then runs after the flagged pass: for each zone with
 * no frame in the subset, its earliest frame is swapped in,
 * displacing the nearest plain, non-endpoint subset member that is
 * neither flagged nor the sole representative of its own zone, so a
 * long take's areas are not left unseen by the reason step
 * (duration-consistency proposal, 2026-10-31; $0, no
 * types.ts change — zoneIds already ride on the request). A zone
 * is left out only when no such member exists, and when zones
 * outnumber slots the earliest zones win. An absent, short, long,
 * or invalid zoneIds list disables the zone pass and keeps the
 * old behavior, so existing 3-argument callers are unchanged.
 * Returns original frame indices, ascending. With no cap pressure
 * (frameCount <= maxFrames) the subset is every frame, so the
 * remap below is the identity.
 */
export function pickReasonFrames(
  frameCount: number,
  flaggedFrames: number[],
  maxFrames: number,
  zoneIds?: Array<number | undefined>,
): number[] {
  if (frameCount <= 0 || maxFrames <= 0) return [];
  // A cap of 1 would divide by zero in the spacing below
  // (i * (frameCount - 1) / (maxFrames - 1)), yielding a NaN subset
  // index and an undefined frame downstream. The route only ever
  // passes 8, but the function is exported, so fail safe: with one
  // slot, the subset is the first frame, which the spacing would
  // have picked first anyway.
  if (maxFrames === 1) return [0];
  if (frameCount <= maxFrames) {
    return Array.from({ length: frameCount }, (_, i) => i);
  }
  const subset: number[] = [];
  const inSubset = new Set<number>();
  for (let i = 0; i < maxFrames; i++) {
    const idx = Math.round((i * (frameCount - 1)) / (maxFrames - 1));
    if (!inSubset.has(idx)) {
      inSubset.add(idx);
      subset.push(idx);
    }
  }
  // Rounding cannot collide when frameCount > maxFrames (step > 1),
  // but fill defensively so the subset is never short.
  for (let i = 0; subset.length < maxFrames && i < frameCount; i++) {
    if (!inSubset.has(i)) {
      inSubset.add(i);
      subset.push(i);
    }
  }
  const flagged = [...new Set(flaggedFrames)]
    .filter((f) => Number.isInteger(f) && f >= 0 && f < frameCount)
    .sort((a, b) => a - b);
  const flaggedSet = new Set(flagged);
  for (const f of flagged) {
    if (inSubset.has(f)) continue;
    let best: number | null = null;
    let bestDist = Infinity;
    for (const m of subset) {
      if (m === 0 || m === frameCount - 1) continue;
      if (flaggedSet.has(m)) continue;
      const dist = Math.abs(m - f);
      if (dist < bestDist) {
        bestDist = dist;
        best = m;
      }
    }
    if (best === null) continue;
    inSubset.delete(best);
    inSubset.add(f);
    subset[subset.indexOf(best)] = f;
  }
  // Zone pass: at least one frame per zone, when zoneIds is usable.
  const zonesValid =
    zoneIds !== undefined &&
    zoneIds.length === frameCount &&
    zoneIds.every((z) => z === undefined || (Number.isInteger(z) && z >= 0));
  if (zonesValid && maxFrames > 1) {
    const zoneOf = (i: number): number | undefined => (zoneIds as Array<number | undefined>)[i];
    const firstOfZone = new Map<number, number>();
    for (let i = 0; i < frameCount; i++) {
      const z = zoneOf(i);
      if (z === undefined || firstOfZone.has(z)) continue;
      firstOfZone.set(z, i);
    }
    for (const [zone, first] of firstOfZone) {
      if (inSubset.has(first)) continue;
      let represented = false;
      for (const m of subset) {
        if (zoneOf(m) === zone) {
          represented = true;
          break;
        }
      }
      if (represented) continue;
      let best: number | null = null;
      let bestDist = Infinity;
      for (const m of subset) {
        if (m === 0 || m === frameCount - 1) continue;
        if (flaggedSet.has(m)) continue;
        const mz = zoneOf(m);
        if (mz !== undefined) {
          let reps = 0;
          for (const n of subset) if (zoneOf(n) === mz) reps++;
          if (reps <= 1) continue;
        }
        const dist = Math.abs(m - first);
        if (dist < bestDist) {
          bestDist = dist;
          best = m;
        }
      }
      if (best === null) continue;
      inSubset.delete(best);
      inSubset.add(first);
      subset[subset.indexOf(best)] = first;
    }
  }
  subset.sort((a, b) => a - b);
  return subset;
}

/**
 * Server-log-only summary of what the capped reason subset covers,
 * zone-wise. Pure, and it changes no plan output: runPlan logs it
 * on capped runs so the next real Large/XL run shows whether the
 * reason step actually saw every area (the zone pass is best
 * effort: a zone is left out when every subset member is an
 * endpoint, a flagged frame, or its own zone's sole representative,
 * and when zones outnumber slots the earliest zones win). Returns
 * null when no frame carries a zoneId, so uncapped and unzoned runs
 * stay quiet, and on malformed input (a non-array side, a
 * non-integer or negative zone id, or a subset index outside the
 * take), the same quiet rule the sibling subset lines follow.
 * Frame indices and zone numbers only, nothing user-identifying.
 */
export function formatReasonSubsetZones(
  zoneIds: Array<number | undefined>,
  subset: number[],
): string | null {
  // The sibling subset lines all stay quiet on malformed input
  // (spacing, segment budget, remap), and this one did not: a
  // non-integer or negative zone id, or a subset index outside the
  // take, used to print straight into the coverage line ("left out:
  // 2.5", or a covered count quietly short by the out-of-range
  // member) with nothing named — and that line is what a capped-run
  // coverage swing is diagnosed from. Return null on malformed
  // input, the same quiet rule the siblings follow. Valid inputs
  // are unchanged: the line below still reads exactly the same
  // fields, and unzoned (undefined) entries still do not count.
  if (!Array.isArray(zoneIds) || !Array.isArray(subset)) return null;
  for (const z of zoneIds) {
    if (z !== undefined && (!Number.isInteger(z) || z < 0)) return null;
  }
  for (const i of subset) {
    if (!Number.isInteger(i) || i < 0 || i >= zoneIds.length) return null;
  }
  const zones = new Set<number>();
  for (const z of zoneIds) if (z !== undefined) zones.add(z);
  if (zones.size === 0) return null;
  const covered = new Set<number>();
  for (const i of subset) {
    const z = zoneIds[i];
    if (z !== undefined) covered.add(z);
  }
  const leftOut = [...zones].filter((z) => !covered.has(z)).sort((a, b) => a - b);
  return `runPlan: reason subset: ${subset.length}/${zoneIds.length} frames, zones ${covered.size}/${zones.size} covered${leftOut.length ? `, left out: ${leftOut.join(", ")}` : ""}`;
}

/**
 * Server-log-only summary of what the capped reason subset kept of
 * SAM's flagged frames. Pure, and it changes no plan output: runPlan
 * logs it on capped runs so a real Large/XL run shows whether the
 * reason step actually saw every flagged frame (the flagged pass is
 * best effort too: a flagged frame is left out only when every
 * subset member is already an endpoint or a flagged frame, which
 * happens when flagged frames outnumber the free slots). Returns
 * null when no frame is flagged, so unflagged runs stay quiet.
 * Frame indices only, nothing user-identifying. Returns null on
 * malformed input (a non-array side), the same quiet rule the
 * sibling subset lines follow, so a bad diagnostic input never
 * throws out of the server log.
 */
export function formatReasonSubsetFlagged(
  flaggedFrames: number[],
  subset: number[],
): string | null {
  // The sibling subset lines all stay quiet on malformed input
  // (zones, spacing, remap), and this one did not: a non-array side
  // either threw in the Set spread (a number or object) or silently
  // miscounted (a string subset never matches a flagged frame, so
  // every flagged frame read as left out). Return null on
  // malformed input, the same quiet rule the siblings follow.
  // Valid inputs are unchanged: flagged frames are still filtered
  // to non-negative integers, counted once, and named when left out.
  if (!Array.isArray(flaggedFrames) || !Array.isArray(subset)) return null;
  const flagged = [...new Set(flaggedFrames)].filter(
    (f) => Number.isInteger(f) && f >= 0,
  );
  if (flagged.length === 0) return null;
  const inSubset = new Set(subset);
  const kept = flagged.filter((f) => inSubset.has(f));
  const leftOut = flagged.filter((f) => !inSubset.has(f)).sort((a, b) => a - b);
  return `runPlan: reason subset: flagged ${kept.length}/${flagged.length} kept${leftOut.length ? `, left out: ${leftOut.join(", ")}` : ""}`;
}

/**
 * Server-log-only summary of the widest time gap between consecutive
 * frames in the capped reason subset. Pure, and it changes no plan
 * output: runPlan logs it on capped runs so a real Large/XL run
 * shows whether the reason step's frames are evenly spread or leave
 * a long stretch of the walk unseen in time. Returns null when the
 * subset has fewer than two frames or any referenced time is not a
 * finite, non-decreasing value, so uncapped and malformed runs stay
 * quiet. Returns null on a non-array side, the same quiet rule the
 * sibling subset lines follow, so a bad diagnostic input never throws
 * out of the server log. Frame indices and seconds only, nothing
 * user-identifying.
 */
export function formatReasonSubsetSpacing(
  tSecs: number[],
  subset: number[],
): string | null {
  // The sibling subset lines all stay quiet on malformed input
  // (zones, flagged, remap), and this one did not: a non-array
  // subset threw in the spread (a number or object) instead of
  // staying quiet, so a bad diagnostic input could throw out of
  // the server log. Return null on a non-array side, the same
  // quiet rule the siblings follow. Valid inputs are unchanged.
  if (!Array.isArray(tSecs) || !Array.isArray(subset)) return null;
  if (subset.length < 2) return null;
  const ordered = [...subset].sort((a, b) => a - b);
  let maxGap = -1;
  let maxPair: [number, number] | null = null;
  let prev: { i: number; t: number } | null = null;
  for (const i of ordered) {
    const t = tSecs[i];
    if (typeof t !== "number" || !Number.isFinite(t)) return null;
    if (prev !== null) {
      const gap = t - prev.t;
      if (gap < 0) return null;
      if (gap > maxGap) {
        maxGap = gap;
        maxPair = [prev.i, i];
      }
    }
    prev = { i, t };
  }
  if (maxPair === null) return null;
  return `runPlan: reason subset: max gap ${maxGap.toFixed(1)}s between frames ${maxPair[0]} and ${maxPair[1]}`;
}

/**
 * Server-log-only summary of whether the SAM request cap bit on
 * the segment step. Pure, and it changes no plan output: runPlan
 * logs it only when the cap dropped labels or the budget was
 * exceeded, so a real Large/XL run shows whether the 300-request
 * cap is the binding constraint (the held SAM-cap scaling decision
 * needs exactly this: if the cap already bites, 450 buys coverage;
 * if it never bites, the reason-subset lines bind instead).
 * Returns null on quiet runs, malformed counts, and a non-array
 * dropped-labels side, so ordinary and malformed runs stay out of
 * the server log. Counts and label names only, nothing
 * user-identifying.
 */
export function formatSegmentBudget(
  frameCount: number,
  requestsMade: number,
  flaggedCount: number,
  budgetExceeded: boolean,
  droppedLabels: string[],
): string | null {
  // The sibling diagnostic lines all stay quiet on malformed input,
  // and this one did not: a non-array dropped-labels side threw in
  // .filter (a number, null, or string) instead of staying quiet,
  // so a bad diagnostic input could throw out of the server log.
  // Return null on a non-array side, the same quiet rule the
  // siblings follow. Valid inputs are unchanged.
  if (!Array.isArray(droppedLabels)) return null;
  const labels = droppedLabels.filter(

    (l) => typeof l === "string" && l.length > 0,
  );
  if (!budgetExceeded && labels.length === 0) return null;
  if (
    !Number.isInteger(frameCount) ||
    frameCount < 0 ||
    !Number.isInteger(requestsMade) ||
    requestsMade < 0 ||
    !Number.isInteger(flaggedCount) ||
    flaggedCount < 0
  )
    return null;
  return `runPlan: segment: cap bit: ${requestsMade} SAM requests on ${frameCount} frames, ${flaggedCount} flagged${labels.length ? `, dropped labels: ${labels.join(", ")}` : ""}`;
}

/**
 * Server-log-only summary of what the capped reason remap dropped.
 * Pure, and it changes no plan output: runPlan logs it only when the
 * remap from subset positions back to plan frames actually drops an
 * issue or a watch entry, so a real Large/XL run shows whether the
 * reason step's output survived the subset (the subset lines above
 * show what the reason step saw; this line shows what came back).
 * Returns null when nothing was dropped and on malformed counts
 * (non-integer, negative, or after > before), so ordinary and
 * malformed runs stay out of the server log. Counts only, nothing
 * user-identifying.
 */
export function formatReasonRemapDropped(
  beforeIssues: number,
  afterIssues: number,
  beforeWatch: number,
  afterWatch: number,
): string | null {
  for (const n of [beforeIssues, afterIssues, beforeWatch, afterWatch]) {
    if (!Number.isInteger(n) || n < 0) return null;
  }
  if (afterIssues > beforeIssues || afterWatch > beforeWatch) return null;
  const droppedIssues = beforeIssues - afterIssues;
  const droppedWatch = beforeWatch - afterWatch;
  if (droppedIssues === 0 && droppedWatch === 0) return null;
  const parts: string[] = [];
  if (droppedIssues > 0) parts.push(`dropped ${droppedIssues} of ${beforeIssues} issues`);
  if (droppedWatch > 0) parts.push(`dropped ${droppedWatch} of ${beforeWatch} watch entries`);
  return `runPlan: reason remap: ${parts.join(", ")}`;
}

/**
 * Server-log-only summary of whether every inventory count has a
 * SAM outline. Pure, and it changes no plan output: runPlan logs
 * it only when at least one count had no outline and was marked
 * estimated, so a real run shows whether the counting check's
 * "estimated" marks came from missing outlines rather than a
 * model disagreement (the processing screen shows the same note
 * to the user, but the server log otherwise keeps no record of
 * it). Returns null when every count has an outline, when there
 * is no inventory, and on malformed counts (non-integer,
 * negative, or no-outline above total), so ordinary and malformed
 * runs stay out of the server log. Counts only, nothing
 * user-identifying.
 */
export function formatCountingOutlines(
  totalInventory: number,
  noOutline: number,
): string | null {
  if (!Number.isInteger(totalInventory) || totalInventory < 0) return null;
  if (!Number.isInteger(noOutline) || noOutline < 0) return null;
  if (totalInventory === 0) return null;
  if (noOutline > totalInventory) return null;
  if (noOutline === 0) return null;
  return `runPlan: counting: ${noOutline} of ${totalInventory} counts had no outline, marked estimated`;
}

/**
 * Server-log-only summary of whether the reviewer saw a proof photo
 * for every issue. Pure, and it changes no plan output: runPlan
 * logs it only when at least one issue has no selected proof photo,
 * so a real run shows whether the 8-photo review cap left an issue
 * unseen (pickReviewFrames takes each issue's first photo first, so
 * a left-out issue means more issues than photo slots, not a
 * missing proof frame). An issue counts as covered when any of its
 * proof frames was selected, and issues with no usable proof frame
 * are ignored, so ordinary and malformed runs stay quiet. Frame
 * indices only, nothing user-identifying.
 */
export function formatReviewCoverage(
  issues: Pick<Issue, "rank" | "frameIndex" | "proofFrames">[],
  selected: number[],
): string | null {
  // The sibling diagnostic lines all stay quiet on malformed input,
  // and this one did not: a non-array side threw in .map/.filter
  // (a number or null), a null issue threw on .frameIndex, and a
  // non-array proofFrames side (or a null proof entry) threw in
  // .map instead of staying quiet, so a bad diagnostic input could
  // throw out of the server log. Return null on malformed input,
  // the same quiet rule the siblings follow. Valid inputs are
  // unchanged: the lines below still read exactly the same fields.
  if (!Array.isArray(issues) || !Array.isArray(selected)) return null;
  for (const issue of issues) {
    if (!issue || typeof issue !== "object") return null;
    const proofFrames = issue.proofFrames;
    if (proofFrames !== undefined && proofFrames !== null && !Array.isArray(proofFrames))
      return null;
    for (const pf of proofFrames ?? []) {
      if (!pf || typeof pf !== "object") return null;
    }
  }
  const chosen = new Set(
    selected.filter((f) => Number.isInteger(f) && f >= 0),
  );
  const withCandidates = issues
    .map((issue) => {
      const candidates = [
        issue.frameIndex,
        ...(issue.proofFrames ?? []).map((pf) => pf.frameIndex),
      ].filter((f) => Number.isInteger(f) && f >= 0);
      return { issue, candidates: [...new Set(candidates)] };
    })
    .filter((entry) => entry.candidates.length > 0);
  if (withCandidates.length === 0) return null;
  const covered = withCandidates.filter((entry) =>
    entry.candidates.some((f) => chosen.has(f)),
  );
  if (covered.length === withCandidates.length) return null;
  const leftOut = [
    ...new Set(
      withCandidates
        .filter((entry) => !entry.candidates.some((f) => chosen.has(f)))
        .map((entry) => entry.issue.frameIndex)
        .filter((f) => Number.isInteger(f) && f >= 0),
    ),
  ].sort((a, b) => a - b);
  return `runPlan: review: ${covered.length}/${withCandidates.length} issues have a proof photo, left out frames: ${leftOut.join(", ")}`;
}

/**
 * Server-log-only summary of what the reviewer verdicts say.
 * Pure, and it changes no plan output: runPlan logs it only when
 * the reviewing step did not run, or when a ran review leaves an
 * issue unverified or without a verdict, so a real run shows
 * whether the reviewer actually backed every problem (a ran review
 * with all issues verified stays quiet, as does a run with no
 * issues: the no-issue case reads as a ran review with no verdicts
 * by design). A verdict counts only when its problemId parses to
 * one of the plan's issue ranks; stray or malformed verdicts are
 * ignored, and the first verdict per rank wins, so ordinary and
 * malformed runs stay out of the server log. Rank numbers only,
 * nothing user-identifying.
 */
export function formatReviewVerdicts(
  review: { ran: boolean; items: Array<{ problemId: string; verified: boolean }> },
  issueRanks: number[],
): string | null {
  if (
    !review ||
    typeof review.ran !== "boolean" ||
    !Array.isArray(review.items) ||
    !Array.isArray(issueRanks)
  )
    return null;
  const ranks = [...new Set(issueRanks.filter((n) => Number.isInteger(n) && n >= 1))].sort(
    (a, b) => a - b,
  );
  if (ranks.length === 0) return null;
  if (!review.ran) return `runPlan: review: did not run for ${ranks.length} issues`;
  const verdicts = new Map<number, boolean>();
  for (const item of review.items) {
    if (!item || typeof item.problemId !== "string" || typeof item.verified !== "boolean")
      continue;
    const rank = Number(item.problemId);
    if (!Number.isInteger(rank) || !ranks.includes(rank) || verdicts.has(rank)) continue;
    verdicts.set(rank, item.verified);
  }
  const verified = ranks.filter((r) => verdicts.get(r) === true);
  const unverified = ranks.filter((r) => verdicts.get(r) === false);
  const noVerdict = ranks.filter((r) => !verdicts.has(r));
  if (unverified.length === 0 && noVerdict.length === 0) return null;
  const parts: string[] = [];
  if (unverified.length > 0) parts.push(`not verified: ${unverified.join(", ")}`);
  if (noVerdict.length > 0) parts.push(`no verdict: ${noVerdict.join(", ")}`);
  return `runPlan: review: ${verified.length}/${ranks.length} issues verified, ${parts.join(", ")}`;
}

/**
 * Server-log-only summary of whether the cost step priced and
 * grounded every material. Pure, and it changes no plan output:
 * runPlan logs it only when at least one material is unpriced or
 * its price is ungrounded, so a real run shows whether the
 * region-grounded cost range is fully priced from search-backed
 * prices or partly estimated (computeCostRange already flags those
 * cases in costRange.assumptions; this line is the one-line
 * server-log summary). Returns null when every material is priced
 * and grounded, when there are no materials, and on malformed
 * counts (non-integer, negative, priced > total, grounded >
 * priced), so ordinary and malformed runs stay out of the server
 * log. Counts only, nothing user-identifying.
 */
export function formatCostPricing(
  totalMaterials: number,
  pricedMaterials: number,
  groundedPrices: number,
): string | null {
  for (const n of [totalMaterials, pricedMaterials, groundedPrices]) {
    if (!Number.isInteger(n) || n < 0) return null;
  }
  if (totalMaterials === 0) return null;
  if (pricedMaterials > totalMaterials || groundedPrices > pricedMaterials) return null;
  if (pricedMaterials === totalMaterials && groundedPrices === pricedMaterials) return null;
  return `runPlan: cost: ${pricedMaterials}/${totalMaterials} materials priced, ${groundedPrices} grounded`;
}

/**
 * Picturing time limit (2026-11-03: a live hosted run was cut at
 * 312 s on a slow comparing step, before picturing, so no plan
 * shipped). When the run is already past this age at picturing, the
 * Image and review calls are skipped so the plan still ships inside
 * the 300 s host limit, with meta.skipped.afterImage and a
 * ran:false review. 230 s leaves ~70 s of headroom for the plan
 * assembly and the response.
 */
export const PICTURING_TIME_LIMIT_MS = 230_000;

/**
 * Pure check for the picturing time-limit skip: true once the run is
 * at least PICTURING_TIME_LIMIT_MS old. nowMs defaults to Date.now
 * so runPlan reads the clock at picturing; tests pass it explicitly
 * for an exact boundary.
 */
export function picturingTimeLimitExceeded(
  startedAtMs: number,
  nowMs: number = Date.now(),
): boolean {
  return nowMs - startedAtMs >= PICTURING_TIME_LIMIT_MS;
}

/**
 * Server-log-only summary of why the picturing step produced no
 * after picture. Pure, and it changes no plan output: runPlan logs
 * it only when renderAfter skipped, so a real run says whether the
 * after picture was skipped cleanly (no frames, no visible fixes),
 * failed on the model, or hit the spike cap (the finished plan's
 * meta.skipped keeps only a boolean, so the reason is otherwise
 * lost). Returns null when an image was produced and on unknown
 * reasons, so ordinary and malformed runs stay out of the server
 * log. The reason string only, nothing user-identifying.
 */
export function formatPicturingSkipped(
  skipped: string | undefined,
): string | null {
  if (
    skipped !== "no-frames" &&
    skipped !== "no-visible-changes" &&
    skipped !== "model-failure" &&
    skipped !== "cap-exceeded"
  )
    return null;
  return `runPlan: picturing skipped: ${skipped}`;
}

/**
 * Server-log-only summary of contract errors the run kept because a
 * reason warning already explains them. Pure, and it changes no plan
 * output: runPlan logs it only when the contract check failed solely
 * on explained fields, so a real run says which contract failures a
 * kept-with-warnings plan shipped with (the draft comment says those
 * errors are "logged, not thrown", but until now no line logged them;
 * the warnings themselves are logged separately above). Returns null
 * when the check passed, when any error is unexplained (that path
 * throws instead), and on malformed inputs, so ordinary runs stay out
 * of the server log. Error strings only, nothing user-identifying.
 */
export function formatExplainedContractErrors(
  errs: string[],
  warnings: string[],
): string | null {
  if (!Array.isArray(errs) || !Array.isArray(warnings)) return null;
  if (errs.length === 0) return null;
  // The sibling diagnostic lines all stay quiet on malformed input,
  // and this one did not: a non-string warning entry threw in key()
  // (.startsWith on a number or null) instead of staying quiet, so
  // a bad diagnostic input could throw out of the server log.
  // Return null on a non-string warning side, the same quiet rule
  // the siblings follow. Valid inputs are unchanged: errs are still
  // filtered to strings and must all be explained to log.
  if (warnings.some((w) => typeof w !== "string")) return null;
  const explained = errs.filter(
    (e) => typeof e === "string" && explainedByReasonWarnings(e, warnings),
  );
  if (explained.length !== errs.length) return null;
  return `runPlan: plan kept with explained contract errors:\n${explained.join("\n")}`;
}

/**
 * Server-log-only summary of a transcription that came back empty
 * even though audio was supplied. Pure, and it changes no plan
 * output: runPlan logs it only when the request carried audio, no
 * pre-supplied transcript, and the transcribe step did not fail,
 * yet the result has no words — so a real run can tell an empty
 * ASR result apart from a silent video (the listening check note
 * reads "No narration in this video" in both cases, and a failed
 * transcribe already warns separately, so neither of those paths
 * logs here). Returns null when audio was not supplied, when a
 * transcript was supplied with the request, when transcribe failed,
 * when any words came back, and on malformed word counts or
 * non-boolean sides, so ordinary runs stay out of the server log. No audio content, no
 * transcript text, nothing user-identifying.
 */
export function formatTranscribeEmpty(
  audioSupplied: boolean,
  transcriptSupplied: boolean,
  transcribeFailed: boolean,
  words: number,
): string | null {
  // The sibling diagnostic lines all stay quiet on malformed input,
  // and this one never checked its boolean sides: a truthy
  // non-boolean (1, "yes") printed the line and a falsy one (0, "")
  // silently passed as false, so a bad diagnostic input could
  // misreport an empty transcription instead of staying quiet.
  // Return null unless all three sides are real booleans, the same
  // quiet rule the siblings follow. Valid inputs are unchanged:
  // the call site passes real booleans already.
  if (
    typeof audioSupplied !== "boolean" ||
    typeof transcriptSupplied !== "boolean" ||
    typeof transcribeFailed !== "boolean"
  )
    return null;
  if (!audioSupplied || transcriptSupplied || transcribeFailed) return null;
  if (!Number.isInteger(words) || words < 0) return null;
  if (words > 0) return null;
  return "runPlan: transcribe returned no words from supplied audio";
}

/**
 * Remap a reason result from subset positions back to plan-frame
 * indices (2026-10-27 11:43 AM review). `subset` maps a subset
 * position to its original frame index; frameTimeSec values need no
 * change, because a subset frame is the same frame (same tSec) as
 * its original. Any index outside the subset is dropped rather
 * than guessed: an issue whose primary frame is outside the subset
 * is dropped (with rank renumbering and rank-reference remapping,
 * as in filterAndRenumber), a stray proof frame is dropped, and a
 * said-vs-seen seen frame outside the subset is dropped to null.
 * An unmentioned issue left with no proof frames is dropped too,
 * or the plan contract would fail it for having none. A watch entry
 * whose primary frame is outside the subset is dropped the same way
 * (watch carries no rank, so no renumbering applies), and a stray
 * watch proof frame is dropped; a watch entry keeps its frameTimeSec
 * and any surviving proof frames. The hero
 * frame is the one index that cannot be dropped: when it falls
 * outside the subset, it falls back to the first subset frame and
 * the fallback is logged server-side, so the render step still has
 * a real frame (flagged for review: confirm or replace with a
 * run failure).
 */
export function remapReasonOutput(output: ReasonOutput, subset: number[]): ReasonOutput {
  if (subset.length === 0) return output;
  const toOriginal = (subsetPos: number): number | null =>
    Number.isInteger(subsetPos) && subsetPos >= 0 && subsetPos < subset.length
      ? subset[subsetPos]
      : null;
  const keptIssues: (typeof output.issues)[number][] = [];
  for (const issue of output.issues) {
    const frameIndex = toOriginal(issue.frameIndex);
    if (frameIndex === null) continue;
    const proofFrames = issue.proofFrames
      ?.map((pf) => {
        const mapped = toOriginal(pf.frameIndex);
        return mapped === null ? null : { ...pf, frameIndex: mapped };
      })
      .filter((pf): pf is NonNullable<typeof pf> => pf !== null);
    if (issue.unmentioned && proofFrames !== undefined && proofFrames.length === 0) {
      continue;
    }
    keptIssues.push({ ...issue, frameIndex, proofFrames });
  }
  const rankRemap = new Map<number, number>();
  keptIssues.forEach((issue, i) => rankRemap.set(issue.rank, i + 1));
  const remapRanks = (ranks: number[] | undefined): number[] | undefined =>
    ranks === undefined
      ? undefined
      : ranks.filter((r) => rankRemap.has(r)).map((r) => rankRemap.get(r) as number);
  const keptWatch: NonNullable<typeof output.watch>[number][] = [];
  for (const entry of output.watch ?? []) {
    const frameIndex = toOriginal(entry.frameIndex);
    if (frameIndex === null) continue;
    const proofFrames = entry.proofFrames
      ?.map((pf) => {
        const mapped = toOriginal(pf.frameIndex);
        return mapped === null ? null : { ...pf, frameIndex: mapped };
      })
      .filter((pf): pf is NonNullable<typeof pf> => pf !== null);
    keptWatch.push({ ...entry, frameIndex, proofFrames });
  }
  const hero = toOriginal(output.heroFrameIndex);
  if (hero === null) {
    console.warn(
      `runPlan: reason heroFrameIndex ${output.heroFrameIndex} outside the reason subset, falling back to subset frame ${subset[0]}`,
    );
  }
  return {
    ...output,
    issues: keptIssues.map((issue) => ({ ...issue, rank: rankRemap.get(issue.rank) as number })),
    watch: keptWatch.length > 0 ? keptWatch : undefined,
    materials: output.materials.map((m) => ({ ...m, forIssues: remapRanks(m.forIssues) })),
    workOrder: output.workOrder.map((s) => ({ ...s, fixes: remapRanks(s.fixes) })),
    saidVsSeen: output.saidVsSeen
      .filter((row) => row.issueRank === undefined || rankRemap.has(row.issueRank))
      .map((row) => {
        if (!row.seen) return { ...row, issueRank: row.issueRank === undefined ? undefined : rankRemap.get(row.issueRank) };
        const seenIndex = toOriginal(row.seen.frameIndex);
        return {
          ...row,
          issueRank: row.issueRank === undefined ? undefined : rankRemap.get(row.issueRank),
          seen: seenIndex === null ? null : { ...row.seen, frameIndex: seenIndex },
        };
      }),
    heroFrameIndex: hero ?? subset[0],
  };
}

/**
 * Fail fast on bad wiring before any step call. The route already
 * validates the request body (planRequest.ts), so this covers the
 * dep side only — the part no step validates up front. Two real
 * gaps closed: a tracker without totals() used to throw only at
 * plan assembly, after the paid reason and cost calls, when
 * planMeta read the totals; and a missing later step bundle (e.g.
 * segment) used to surface only at its own stage, after the
 * earlier paid calls. A bad reasonMaxFrames is caught here too:
 * pickReasonFrames returns [] for a cap <= 0, which would hand
 * the reason step no frames at all.
 */
export function validateRunPlanDeps(deps: RunPlanDeps): void {
  if (deps === null || typeof deps !== "object" || Array.isArray(deps)) {
    throw new Error("runPlan: deps is not an object");
  }
  for (const field of ["transcribe", "segment", "reason", "cost", "renderAfter"] as const) {
    const v = deps[field];
    if (v === null || typeof v !== "object" || Array.isArray(v)) {
      throw new Error(`runPlan: ${field} deps is not an object`);
    }
  }
  if (
    deps.tracker === null ||
    typeof deps.tracker !== "object" ||
    typeof deps.tracker.record !== "function" ||
    typeof deps.tracker.totals !== "function"
  ) {
    throw new Error("runPlan: tracker.record and tracker.totals must be functions");
  }
  if (
    deps.planProvider !== undefined &&
    deps.planProvider !== "meta" &&
    deps.planProvider !== "baseten"
  ) {
    throw new Error(`runPlan: planProvider must be meta or baseten, got ${deps.planProvider}`);
  }
  if (
    deps.reasonMaxFrames !== undefined &&
    (!Number.isInteger(deps.reasonMaxFrames) || deps.reasonMaxFrames < 1)
  ) {
    throw new Error("runPlan: reasonMaxFrames must be a whole number >= 1 when given");
  }
  if (
    deps.segmentConcurrency !== undefined &&
    (!Number.isInteger(deps.segmentConcurrency) || deps.segmentConcurrency < 1)
  ) {
    throw new Error("runPlan: segmentConcurrency must be a whole number >= 1 when given");
  }
  for (const field of ["reasonPrompt", "costPrompt", "reviewPrompt", "onStatus"] as const) {
    if (deps[field] !== undefined && typeof deps[field] !== "function") {
      throw new Error(`runPlan: ${field} must be a function when given`);
    }
  }
  if (deps.review !== undefined) {
    if (
      deps.review === null ||
      typeof deps.review !== "object" ||
      typeof deps.review.callSpark !== "function"
    ) {
      throw new Error("runPlan: review.callSpark must be a function when given");
    }
  }
  if (
    (deps.review === undefined) !== (deps.reviewPrompt === undefined)
  ) {
    throw new Error("runPlan: review and reviewPrompt must be given together");
  }
  if (deps.signal !== undefined && (deps.signal === null || typeof deps.signal !== "object")) {
    throw new Error("runPlan: signal must be an object when given");
  }
  if (
    deps.startedAtMs !== undefined &&
    (!Number.isFinite(deps.startedAtMs) || deps.startedAtMs < 0)
  ) {
    throw new Error("runPlan: startedAtMs must be a finite number >= 0 when given");
  }
}


/**
 * Shape check for a direct runPlan caller. The route already deep-validates
 * the body with validatePlanRequest (src/lib/pipeline/planRequest.ts), but
 * runPlan is also callable on its own, and until now it trusted the request
 * outright: a non-object request threw a bare TypeError, and an
 * empty-frames request paid for transcription before the segment step
 * failed. This fails fast, before the first step, with the same
 * "runPlan: ..." phrasing as validateRunPlanDeps. Shape only: it mirrors
 * the route validator's frame and image checks so a direct caller fails
 * fast the same way; WAV format stays with the route validator and the
 * step validators.
 */
/**
 * True when the string is valid base64, by the same rule the route
 * validator uses (src/lib/pipeline/planRequest.ts): base64 alphabet
 * plus up to two padding chars, length a multiple of 4, whitespace
 * ignored. Used only by validateRunPlanRequest below.
 */
function isBase64(value: string): boolean {
  const stripped = value.replace(/\s/g, "");
  return /^[A-Za-z0-9+/]*={0,2}$/.test(stripped) && stripped.length % 4 === 0;
}

/**
 * True when the base64 string decodes to a real image header, by the
 * same magic-byte rule the route validator uses: JPEG (FF D8 FF),
 * PNG (89 50 4E 47 0D 0A 1A 0A), GIF ("GIF87a"/"GIF89a"), or WebP
 * ("RIFF" + "WEBP" at bytes 8-11). Only the first 12 bytes are
 * decoded, with atob (not Buffer) so this pure module stays free of
 * node types. A payload too short to hold any header fails.
 */
function isImageBase64(value: string): boolean {
  const stripped = value.replace(/\s/g, "");
  const chunk = stripped.slice(0, 16);
  if (chunk.length < 8) return false;
  const head = atob(chunk.length % 4 === 0 ? chunk : chunk.slice(0, chunk.length - (chunk.length % 4)));
  const b = (i: number): number => head.charCodeAt(i);
  if (head.length >= 3 && b(0) === 0xff && b(1) === 0xd8 && b(2) === 0xff) return true;
  if (
    head.length >= 8 &&
    b(0) === 0x89 && b(1) === 0x50 && b(2) === 0x4e && b(3) === 0x47 &&
    b(4) === 0x0d && b(5) === 0x0a && b(6) === 0x1a && b(7) === 0x0a
  ) return true;
  if (head.length >= 6 && head.slice(0, 6) === "GIF87a") return true;
  if (head.length >= 6 && head.slice(0, 6) === "GIF89a") return true;
  if (head.length >= 12 && head.slice(0, 4) === "RIFF" && head.slice(8, 12) === "WEBP") return true;
  return false;
}


/**
 * True when the base64 string decodes to a WAV header, by the same
 * rule the route validator uses (src/lib/pipeline/planRequest.ts):
 * the first four bytes are "RIFF" and bytes 8-11 are "WAVE". An
 * empty string passes here because the transcribe step treats it as
 * no audio, not as malformed audio. Decoded with atob (not Buffer)
 * so this pure module stays free of node types.
 */
function isWavBase64(value: string): boolean {
  const stripped = value.replace(/\s/g, "");
  if (stripped.length === 0) return true;
  if (stripped.length < 16) return false;
  const head = atob(stripped.slice(0, 16));
  return head.length >= 12 && head.slice(0, 4) === "RIFF" && head.slice(8, 12) === "WAVE";
}

/**
 * True when the WAV is in the format Meta transcribe accepts, by the
 * same rule the route validator uses: mono s16le at 16000 or 24000 Hz
 * (8 kHz got a 400 on 2026-10-28). The fmt chunk is found by scanning
 * RIFF chunks, not by assuming it sits at offset 12. Empty passes
 * (no audio), and a WAV with no fmt chunk in the decoded head passes
 * too and is left to the transcribe step, so this only rejects audio
 * Meta is known to refuse.
 */
function isTranscribeWavBase64(value: string): boolean {
  const stripped = value.replace(/\s/g, "");
  if (stripped.length === 0) return true;
  // 200 bytes covers a standard header plus small leading chunks.
  const chunk = stripped.slice(0, 268);
  const head = atob(chunk.slice(0, chunk.length - (chunk.length % 4)));
  if (head.length < 12) return false;
  const u16 = (i: number): number => head.charCodeAt(i) | (head.charCodeAt(i + 1) << 8);
  const u32 = (i: number): number =>
    head.charCodeAt(i) |
    (head.charCodeAt(i + 1) << 8) |
    (head.charCodeAt(i + 2) << 16) |
    (head.charCodeAt(i + 3) << 24);
  let off = 12;
  while (off + 8 <= head.length) {
    const id = head.slice(off, off + 4);
    const size = u32(off + 4);
    if (id === "fmt " && size >= 16 && off + 8 + 16 <= head.length) {
      const format = u16(off + 8);
      const channels = u16(off + 10);
      const sampleRate = u32(off + 12);
      const bits = u16(off + 22);
      return (
        format === 1 &&
        channels === 1 &&
        (sampleRate === 16000 || sampleRate === 24000) &&
        bits === 16
      );
    }
    off += 8 + size + (size % 2);
  }
  return true;
}

/** Max decoded bytes per runPlan frame, same shape as the reason/segment step 5 MB frame caps. */
const MAX_RUNPLAN_IMAGE_BYTES = 5 * 1024 * 1024;

export function validateRunPlanRequest(request: PlanRequest): void {
  if (request === null || typeof request !== "object" || Array.isArray(request)) {
    throw new Error("runPlan: request is not an object");
  }
  if (
    typeof request.durationSec !== "number" ||
    !Number.isFinite(request.durationSec) ||
    request.durationSec < 0
  ) {
    throw new Error("runPlan: durationSec must be a number >= 0");
  }
  if (!Array.isArray(request.frames) || request.frames.length === 0) {
    throw new Error("runPlan: frames must be a non-empty array");
  }
  // Parity with the route validator (src/lib/pipeline/planRequest.ts):
  // the browser builder sends at most 48 frames, and the route
  // rejects more before any model call is spent. A direct runPlan
  // caller with 49+ frames inside durationSec used to pass here and
  // only hit the reason step's image limit mid-run; it gets the same
  // fail-fast here instead of only via the route.
  if (request.frames.length > MAX_PLAN_FRAMES) {
    throw new Error(`runPlan: frames must not exceed ${MAX_PLAN_FRAMES}`);
  }
  // Parity with the route validator (src/lib/pipeline/planRequest.ts):
  // frames must arrive in walkthrough order (non-decreasing tSec) —
  // the reason subset picks evenly spaced frames by position, so an
  // out-of-order request would silently mis-order the comparison, while
  // the route already fails fast on the same input.
  let prevTsec = 0;
  request.frames.forEach((frame, i) => {
    if (
      frame === null ||
      typeof frame !== "object" ||
      typeof frame.tSec !== "number" ||
      !Number.isFinite(frame.tSec) ||
      frame.tSec < 0 ||
      typeof frame.dataUrl !== "string" ||
      frame.dataUrl.trim().length === 0
    ) {
      throw new Error(`runPlan: frames[${i}] has no valid tSec/dataUrl`);
    }
    if (frame.tSec < prevTsec) {
      throw new Error(
        `runPlan: frames[${i}].tSec must not be earlier than the previous frame`,
      );
    }
    // Proposal B contract (types.ts): an optional zoneId per frame,
    // one small integer from 0 per physical area. A direct runPlan
    // caller gets the same fail-fast as runSegment instead of
    // silently counting a bad zone id as its own zone.
    if (
      frame.zoneId !== undefined &&
      (!Number.isInteger(frame.zoneId) || frame.zoneId < 0)
    ) {
      throw new Error(
        `runPlan: frames[${i}].zoneId must be a whole number >= 0 when given`,
      );
    }
    // Parity with the route validator (src/lib/pipeline/planRequest.ts):
    // a frame timestamp past durationSec would mislabel that proof
    // frame's time on the plan screen, while the route already fails
    // fast on the same input. A direct runPlan caller gets the same
    // fail-fast here instead of only via the route.
    if (frame.tSec > request.durationSec) {
      throw new Error(
        `runPlan: frames[${i}].tSec must not exceed durationSec`,
      );
    }
    // Parity with the route validator (src/lib/pipeline/planRequest.ts):
    // a frame dataUrl must be a data:image base64 URL carrying a real
    // image header. A bare string (or a text blob re-labelled
    // data:image/jpeg) used to pass here and only surface later, when
    // the segment step skipped and the plan silently lost
    // segmentation. A direct runPlan caller gets the same fail-fast
    // here instead of only via the route.
    if (
      !frame.dataUrl.startsWith("data:image/") ||
      !frame.dataUrl.includes(";base64,")
    ) {
      throw new Error(
        `runPlan: frames[${i}].dataUrl must be a data:image base64 URL`,
      );
    }
    {
      const payload = frame.dataUrl.slice(frame.dataUrl.indexOf(";base64,") + 8);
      if (payload.length === 0 || !isBase64(payload)) {
        throw new Error(
          `runPlan: frames[${i}].dataUrl must carry valid base64 image data`,
        );
      }
      if (!isImageBase64(payload)) {
        throw new Error(
          `runPlan: frames[${i}].dataUrl must carry image data (JPEG, PNG, WebP, or GIF)`,
        );
      }
      // Same shape as the reason step's and segment step's frame caps:
      // the runPlan frames are 1024 px JPEGs, but a direct runPlan
      // caller had no per-frame bound here, so an unbounded frame
      // only surfaced at the reason/segment step caps mid-run, after
      // request budgeting. Reject it at validation instead, before
      // any step runs, so the orchestrator fails fast with the frame
      // index. 5 MB decoded is wide headroom over a 1024 px JPEG
      // frame, so no valid request changes.
      {
        const stripped = payload.replace(/\s/g, "");
        const padding = stripped.endsWith("==") ? 2 : stripped.endsWith("=") ? 1 : 0;
        const decodedBytes = (stripped.length * 3) / 4 - padding;
        if (decodedBytes > MAX_RUNPLAN_IMAGE_BYTES) {
          throw new Error(
            `runPlan: frames[${i}].dataUrl must be at most 5 MB, got ${decodedBytes} bytes`,
          );
        }
      }
    }
    prevTsec = frame.tSec;
  });
  for (const field of ["spaceName", "spaceType", "region"] as const) {
    if (request[field] !== undefined && typeof request[field] !== "string") {
      throw new Error(`runPlan: ${field} must be a string when given`);
    }
    // Parity with the route validator (src/lib/pipeline/planRequest.ts):
    // an empty string means "not given", but a spaces-only label would
    // print as a blank label on the plan screen, so a direct runPlan
    // caller gets the same fail-fast here instead of only via the route.
    if (
      typeof request[field] === "string" &&
      request[field].length > 0 &&
      request[field].trim().length === 0
    ) {
      throw new Error(`runPlan: ${field} must not be blank when given`);
    }
  }
  // Parity with validateCostPromptInput (src/lib/pipeline/planPrompts.ts):
  // the cost step runs after the reason step, so a region carrying a
  // newline or a {{...}} placeholder used to pass here, spend the paid
  // reason call, and only fail when the cost prompt was built — the
  // cost prompt rejects both, since a newline breaks its one-line
  // region slot and a placeholder would be expanded by a later fill.
  // A direct runPlan caller gets the same fail-fast here, before any
  // step runs. Only a given string is checked, so an omitted or empty
  // region (no cost step) keeps its behavior, and a blank one keeps
  // its message from the loop above. Real runs are already clean
  // (the route hands runPlan the region the user typed), so no
  // current run changes.
  if (typeof request.region === "string" && /[\r\n]/.test(request.region)) {
    throw new Error("runPlan: region must not contain a newline");
  }
  if (typeof request.region === "string" && /\{\{[a-z_]+\}\}/.test(request.region)) {
    throw new Error("runPlan: region must not contain a {{...}} placeholder");
  }
  // Parity with buildReasonPrompt (src/lib/pipeline/planPrompts.ts):
  // the reason step builds its prompt after the listening and
  // looking/counting steps, so a spaceName or spaceType carrying a
  // newline or a {{...}} placeholder, or a spaceName carrying a
  // double quote, used to pass here, spend the transcribe and
  // segment calls, and only fail when the reason prompt was built
  // — a newline splits the prompt line carrying it, a placeholder
  // would be expanded by a later fill, and a quote in spaceName
  // closes the quoted name in the template. A direct runPlan
  // caller gets the same fail-fast here, before any step runs.
  // Only given strings are checked, so an omitted label keeps its
  // behavior, and a blank one keeps its message from the loop
  // above. Real runs are already clean (the route hands runPlan
  // the labels the user typed), so no current run changes.
  for (const field of ["spaceName", "spaceType"] as const) {
    if (typeof request[field] === "string" && /[\r\n]/.test(request[field])) {
      throw new Error(`runPlan: ${field} must not contain a newline`);
    }
    if (
      typeof request[field] === "string" &&
      /\{\{[a-z_]+\}\}/.test(request[field])
    ) {
      throw new Error(`runPlan: ${field} must not contain a {{...}} placeholder`);
    }
  }
  if (typeof request.spaceName === "string" && request.spaceName.includes('"')) {
    throw new Error('runPlan: spaceName must not contain a double quote');
  }
  if (request.audioWavBase64 !== undefined && typeof request.audioWavBase64 !== "string") {
    throw new Error("runPlan: audioWavBase64 must be a string when given");
  }
  // Parity with the route validator (src/lib/pipeline/planRequest.ts):
  // an empty string means "not given" (runTranscribe returns no
  // transcript), but a spaces-only string is truthy, so it rides past
  // the no-audio skip into runTranscribe and dies there with a
  // misleading "not a WAV file" error. A direct runPlan caller gets
  // the same fail-fast here instead of only via the route.
  if (
    typeof request.audioWavBase64 === "string" &&
    request.audioWavBase64.length > 0 &&
    request.audioWavBase64.trim().length === 0
  ) {
    throw new Error("runPlan: audioWavBase64 must not be blank when given");
  }
  // Parity with the route validator (src/lib/pipeline/planRequest.ts):
  // a direct runPlan caller with malformed audio used to pass here
  // and only fail at the listening step, after runPlan had started,
  // when the transcribe step rejected it. A non-base64 string, a
  // valid-base64 non-WAV blob, or a WAV in a format Meta refuses
  // (stereo, 8-bit, 8 kHz) gets the same fail-fast here instead of
  // only via the route. Empty passes (no audio), as above.
  if (
    typeof request.audioWavBase64 === "string" &&
    !isBase64(request.audioWavBase64)
  ) {
    throw new Error("runPlan: audioWavBase64 must be valid base64");
  }
  // Parity with validateTranscribeInput (src/lib/pipeline/transcribe.ts):
  // the transcribe step caps audio at 32 MB, but a direct runPlan
  // caller with oversized audio used to pass here and only fail at
  // the listening step, after the run had started. A direct caller
  // gets the same fail-fast here instead of only via the step.
  // The route validator needs no such check: its 10 MB body cap
  // already bounds audio below 32 MB. Empty passes (no audio).
  // Byte count mirrors transcribe's audioByteLength (floor of the
  // whitespace-stripped length times 3/4, padding ignored), so the
  // boundary agrees with the step's own check.
  if (typeof request.audioWavBase64 === "string") {
    const stripped = request.audioWavBase64.replace(/\s/g, "");
    const bytes = Math.floor((stripped.length * 3) / 4);
    if (bytes > MAX_AUDIO_BYTES) {
      throw new Error(
        `runPlan: audioWavBase64 must be at most 32 MB, got ${bytes} bytes`,
      );
    }
  }
  if (
    typeof request.audioWavBase64 === "string" &&
    !isWavBase64(request.audioWavBase64)
  ) {
    throw new Error("runPlan: audioWavBase64 must be a WAV file (RIFF/WAVE header)");
  }
  if (
    typeof request.audioWavBase64 === "string" &&
    !isTranscribeWavBase64(request.audioWavBase64)
  ) {
    throw new Error(
      "runPlan: audioWavBase64 must be mono 16-bit WAV at 16000 or 24000 Hz (the format Meta transcribe accepts)",
    );
  }
  // Plan-side half of option (b) (2026-10-29):
  // a request may carry narration already transcribed by POST
  // /api/transcribe instead of the WAV. A supplied transcript is
  // validated here, like the other request fields, so a direct
  // caller fails fast instead of handing the reason step a bad
  // transcript mid-run. Null means no narration, matching
  // TranscribeOutput; a blank string is neither a transcript nor
  // null, so it fails. Turns without a transcript would be
  // silently ignored by the listening stage below, so they fail
  // too — the pair arrives together from /api/transcribe.
  if (
    request.transcript !== undefined &&
    request.transcript !== null &&
    typeof request.transcript !== "string"
  ) {
    throw new Error("runPlan: transcript must be a string or null when given");
  }
  if (
    typeof request.transcript === "string" &&
    request.transcript.trim().length === 0
  ) {
    throw new Error("runPlan: transcript must not be blank when given");
  }
  if (request.transcriptTurns !== undefined) {
    if (!Array.isArray(request.transcriptTurns)) {
      throw new Error("runPlan: transcriptTurns must be an array when given");
    }
    // Null means no narration (the transcribe route's empty result),
    // so non-empty turns with a null transcript contradict it just as
    // turns with no transcript at all do: the listening stage would
    // hand the reason step a null transcript while the finished plan
    // still carried the turns. An empty turns array with null stays
    // valid — that is the real empty-narration case from
    // /api/transcribe. (The route validator in planRequest.ts
    // checks the same pair, so a bad pair fails on "uploading".)
    if (
      request.transcript === undefined ||
      (request.transcript === null && request.transcriptTurns.length > 0)
    ) {
      throw new Error("runPlan: transcriptTurns given without transcript");
    }
    // Parity with the route validator (src/lib/pipeline/planRequest.ts):
    // turns must arrive in walkthrough order (non-decreasing
    // startSec), like frames above: the reason step reads narration
    // against frames in that order, so an out-of-order turn would
    // misalign what was said with what was seen, while the route
    // already fails fast on the same input. A direct runPlan caller
    // gets the same fail-fast here instead of only via the route.
    // Equal startSec passes, as with frames.
    let prevTurnStartSec = -Infinity;
    request.transcriptTurns.forEach((turn, i) => {
      if (
        turn === null ||
        typeof turn !== "object" ||
        typeof turn.startSec !== "number" ||
        !Number.isFinite(turn.startSec) ||
        turn.startSec < 0 ||
        typeof turn.text !== "string" ||
        (turn.endSec !== undefined &&
          (typeof turn.endSec !== "number" ||
            !Number.isFinite(turn.endSec) ||
            turn.endSec < 0))
      ) {
        throw new Error(`runPlan: transcriptTurns[${i}] is not a valid turn`);
      } else if (
        // A turn with no words carries no narration: parseTurns
        // (src/lib/pipeline/transcribe.ts) already drops blank
        // turns and trims the rest, so a blank turn here comes
        // only from a direct caller, and the reason step would
        // otherwise carry an empty line into the "said vs saw"
        // alignment. Real turns from /api/transcribe are never
        // blank, so no current run changes.
        typeof turn.text === "string" &&
        turn.text.trim().length === 0
      ) {
        throw new Error(`runPlan: transcriptTurns[${i}].text must not be blank`);
      } else if (
        // A turn that ends before it starts is malformed, not just
        // out of order: the "said vs saw" alignment reads turns in
        // time order, so an inverted turn would misplace narration
        // instead of failing. The shape check above already rejects
        // a non-numeric endSec, so this only fires on a real number
        // earlier than startSec. Real turns (from /api/transcribe)
        // never invert, so no current run changes.
        typeof turn.endSec === "number" &&
        turn.endSec < turn.startSec
      ) {
        throw new Error(`runPlan: transcriptTurns[${i}].endSec must not be earlier than startSec`);
      }
      if (turn.startSec < prevTurnStartSec) {
        throw new Error(
          `runPlan: transcriptTurns[${i}].startSec must not be earlier than the previous turn`,
        );
      }
      // Parity with the route validator (src/lib/pipeline/planRequest.ts):
      // a turn that starts after the video ends cannot line up with
      // anything seen, so it would mislabel narration on the plan
      // screen, while the route already fails fast on the same input.
      // Only the start is checked: an endSec past durationSec is
      // harmless for alignment, since the turn itself still starts
      // inside the video. Real turns from /api/transcribe start
      // inside the audio, so no current run changes.
      if (turn.startSec > request.durationSec) {
        throw new Error(
          `runPlan: transcriptTurns[${i}].startSec must not exceed durationSec`,
        );
      }
      prevTurnStartSec = turn.startSec;
    });
  }
  if (
    request.laborBasis !== undefined &&
    request.laborBasis !== "volunteer" &&
    request.laborBasis !== "contractor" &&
    request.laborBasis !== "mixed"
  ) {
    throw new Error("runPlan: laborBasis must be volunteer, contractor, or mixed when given");
  }
}

/**
 * Run the full pipeline for one request. The segment stage covers both
 * the "looking" and "counting" UI steps (one SAM pass does hazards and
 * counts), so both statuses are emitted around it. A segment failure
 * no longer stops the run: it is logged server-side, looking and
 * counting are reported as skipped on every later running status, and
 * the reason step continues with no segmentation counts, so a blocked
 * SAM step never kills a real plan run (2026-10-27 11:20 AM review).
 */

/** One proof photo as the review prompt names it, in attach order (Photo A, B, ...). */
export interface ReviewPhoto {
  letter: string;
  /** Index into the plan's frames. */
  frameIndex: number;
  /** Seconds into the video, for the prompt's m:ss times. */
  tSec: number;
}

/** What reviewPrompt receives: the finished plan's issues plus the selected photos. */
export interface ReviewPromptInput {
  spaceType?: string;
  /** The plan's issues, in rank order. */
  issues: Issue[];
  /** Selected proof photos, in attach order. The builder derives each
   * problem's own photo letters (and captions, from that issue's
   * proofFrames) from these frame indices. */
  photos: ReviewPhoto[];
}

/**
 * Pick the proof photos the reviewer sees, by prompt 06's photo list
 * rule: per issue in rank order, its primary frame first, then its
 * proofFrames in order; dedupe keeping first appearance. When more
 * than MAX_REVIEW_IMAGES candidates exist, every issue's first photo
 * wins a slot before any issue's second photo, then the remaining
 * slots fill by ascending frame index. Returns the selected frame
 * indices ascending: that is the attach order (Photo A is the
 * earliest frame), so the letters stay stable whatever the issue
 * order was. Frames outside the plan are dropped, never guessed.
 */
export function pickReviewFrames(
  issues: Pick<Issue, "rank" | "frameIndex" | "proofFrames">[],
  frameCount?: number,
): number[] {
  const inRange = (i: number): boolean =>
    Number.isInteger(i) && i >= 0 && (frameCount === undefined || i < frameCount);
  const ranked = [...issues].sort((a, b) => a.rank - b.rank);
  const perIssue: number[][] = ranked.map((issue) => {
    const seen = new Set<number>();
    const out: number[] = [];
    const candidates = [issue.frameIndex, ...(issue.proofFrames ?? []).map((pf) => pf.frameIndex)];
    for (const fi of candidates) {
      if (inRange(fi) && !seen.has(fi)) {
        seen.add(fi);
        out.push(fi);
      }
    }
    return out;
  });
  const selected: number[] = [];
  const chosen = new Set<number>();
  for (const list of perIssue) {
    if (selected.length >= MAX_REVIEW_IMAGES) break;
    const first = list[0];
    if (first !== undefined && !chosen.has(first)) {
      chosen.add(first);
      selected.push(first);
    }
  }
  const rest: number[] = [];
  for (const list of perIssue) {
    for (const fi of list) {
      if (!chosen.has(fi) && !rest.includes(fi)) rest.push(fi);
    }
  }
  rest.sort((a, b) => a - b);
  for (const fi of rest) {
    if (selected.length >= MAX_REVIEW_IMAGES) break;
    chosen.add(fi);
    selected.push(fi);
  }
  return selected.sort((a, b) => a - b);
}

/** The selected proof photos as prompt letters, from the plan's frames. */
export function buildReviewPhotos(
  issues: Pick<Issue, "rank" | "frameIndex" | "proofFrames">[],
  frames: Pick<PlanFrame, "tSec">[],
): ReviewPhoto[] {
  return pickReviewFrames(issues, frames.length).map((fi, i) => ({
    letter: String.fromCharCode(65 + i),
    frameIndex: fi,
    tSec: frames[fi].tSec,
  }));
}

export async function runPlan(request: PlanRequest, deps: RunPlanDeps): Promise<WorkPlan> {
  // Optional steps skipped so far this run, in stage order. Attached
  // to every later running status (2026-10-27 5:45 PM review), so
  // the processing screen can mark them skipped live instead of
  // waiting for the finished plan's meta.skipped. Picturing is last,
  // so its skip has no later running line and still arrives only via
  // the done plan's meta.skipped.
  const skippedSteps: Exclude<PlanStep, "done">[] = [];
  // Run start for the picturing time-limit skip: the route's handler
  // start when given, else this function's own start.
  const runStartedAtMs = deps.startedAtMs ?? Date.now();
  /**
   * One running line, optionally carrying the check for the step it
   * names (2026-10-30: after a step's output is checked and
   * before the next step uses it, send one more running line for the
   * same step with its check; skipped rides along as usual). A check
   * line is never a failure: ok:false means the run carried on with
   * the finding marked.
   */
  const emit = (step: RunStep, check?: StepCheck): void => {
    deps.onStatus?.(
      skippedSteps.length > 0
        ? { state: "running", step, skipped: [...skippedSteps], ...(check ? { check } : {}) }
        : { state: "running", step, ...(check ? { check } : {}) },
    );
  };

  // One meta object for both the draft and the final plan, so the
  // engine label never drifts between the two contract checks.
  // Skipped-step flags for the plan screen (2026-10-27
  // 12:05 PM review): masks when the segment step failed or was skipped
  // (segmentation null), afterImage when the render step produced no
  // image, cost when a regioned cost call failed (2026-10-27
  // 2:15 PM review; a run with no region sets no cost flag),
  // transcribe when the transcribe call failed and the run went on
  // without narration (2026-10-31 3:20 AM review).
  // Callers pass the flags; this helper only assembles them,
  // so no step result is read before it exists.
  const planMeta = (
    masksSkipped: boolean,
    afterImageSkipped: boolean,
    costSkipped = false,
    transcribeSkipped = false,
  ): NonNullable<WorkPlan["meta"]> => {
    const skipped: { masks?: boolean; afterImage?: boolean; cost?: boolean; transcribe?: boolean } = {};
    if (masksSkipped) skipped.masks = true;
    if (afterImageSkipped) skipped.afterImage = true;
    if (costSkipped) skipped.cost = true;
    if (transcribeSkipped) skipped.transcribe = true;
    // Which model actually wrote each step, from the usage records
    // the steps already logged (judging ask, 2026-10-30 4:44 PM):
    // the panel stops inferring model ids and shows the real ones.
    // Record steps map to panel keys: estimateCost -> cost,
    // renderAfter -> image. First model per step wins; retries keep
    // the same model, and cleanup records ride under no key, so a
    // step that never called records no model. The renderAfter
    // judge call records under its own step, so it gets its own
    // key: it runs a different model than the image call, and
    // without this its model was dropped from meta.models even
    // though its spend was already in meta.costUsd.
    const MODEL_STEP_KEYS: Record<string, string> = {
      transcribe: "transcribe",
      segment: "segment",
      reason: "reason",
      estimateCost: "cost",
      renderAfter: "image",
      renderAfterJudge: "judge",
      review: "review",
    };
    const models: Record<string, string> = {};
    for (const rec of deps.tracker.records()) {
      const key = MODEL_STEP_KEYS[rec.step];
      if (key && !(key in models)) models[key] = rec.model;
    }
    return {
      costUsd: deps.tracker.totals().spikeTotalUsd,
      ...(Object.keys(models).length > 0 ? { models } : {}),
      ...(deps.planProvider ? { planProvider: deps.planProvider } : {}),
      // The region the run was asked for, when one was given: the plan
      // itself then says where it is even when the cost step failed
      // and costRange is null. An empty region means "not given" and
      // stays omitted, as before; a server-set region always wins over
      // the browser stamp because the client keeps a server value.
      ...(request.region?.trim() ? { region: request.region } : {}),
      ...(Object.keys(skipped).length > 0 ? { skipped } : {}),
    };
  };

  // listening: transcribe the narration, or null when there is none.
  // Plan-side half of option (b) (2026-10-29):
  // when the request already carries a transcript (pre-transcribed
  // by POST /api/transcribe), it is authoritative and the transcribe
  // step is skipped entirely — no call, no cost — even when
  // audioWavBase64 is also present, so the browser never pays for
  // the same narration twice and a transcript-carrying request is
  // never silently re-transcribed. Answer to the 10:05 PM log question: transcript present + audio present prefers the
  // transcript. Omit both transcript fields and the pipeline
  // transcribes audioWavBase64 as before.
  assertNotAborted(deps.signal);
  validateRunPlanDeps(deps);
  validateRunPlanRequest(request);
  emit("listening");
  let transcript: string | null;
  let transcriptTurns: NonNullable<WorkPlan["transcriptTurns"]>;
  let transcribeSkipped = false;
  if (request.transcript !== undefined) {
    transcript = request.transcript;
    transcriptTurns = request.transcriptTurns ?? [];
  } else {
    try {
      const transcribed = await runTranscribe(
        { audioWavBase64: request.audioWavBase64, spaceType: request.spaceType },
        { ...deps.transcribe, signal: deps.signal },
      );
      transcript = transcribed.transcript;
      transcriptTurns = transcribed.transcriptTurns;
    } catch (err) {
      if (isAbort(err)) throw err;
      // A cap breach is a spending stop, not a transcribe failure:
      // stop the run instead of continuing to steps that would
      // spend another call each, as segment and cost already do.
      if (isSpikeCapError(err))
        throw new PlanStepError("listening", PLAIN_FAILURE_MESSAGE.listening, detailOf(err));
      // Transcribe is optional (2026-10-31 3:20 AM review):
      // a flaky ASR call costs the said-vs-seen part, not the plan.
      // The finished plan carries meta.skipped.transcribe, which
      // the panel's Listen row already renders as off, and the
      // listening check below says so instead of claiming nobody
      // spoke. A supplied transcript never reaches this branch, so
      // a pre-transcribed run is untouched.
      console.warn(`runPlan: transcribe failed, continuing without narration: ${detailOf(err)}`);
      transcript = null;
      transcriptTurns = [];
      transcribeSkipped = true;
    }
  }

  // listening check: the narration this run actually has, by the
  // same rule stepChecks.ts uses for the finished plan (words from
  // the turns when present, else the "[12.4] text" transcript lines;
  // no narration reads as a passing check, not a failure).
  {
    const narrated = Boolean(transcript?.trim()) || transcriptTurns.length > 0;
    const words = narrated ? transcriptWords({ transcript, transcriptTurns }) : 0;
    emit(
      "listening",
      narrated
        ? { ok: words > 0, note: `Transcript: ${words} ${words === 1 ? "word" : "words"}` }
        : transcribeSkipped
          ? { ok: true, note: "Transcription unavailable this run" }
          : { ok: true, note: "No narration in this video" },
    );
  }

  // Server log only: whether supplied audio transcribed to nothing
  // (see the helper note). No plan output, no UI change: the
  // listening check above already reports the word count, but it
  // cannot tell an empty ASR result from a video with no narration.
  {
    const hasWords =
      Boolean(transcript?.trim()) || transcriptTurns.length > 0;
    const words = hasWords
      ? transcriptWords({ transcript, transcriptTurns })
      : 0;
    const emptyTranscribe = formatTranscribeEmpty(
      typeof request.audioWavBase64 === "string" &&
        request.audioWavBase64.length > 0,
      request.transcript !== undefined,
      transcribeSkipped,
      words,
    );
    if (emptyTranscribe) console.log(emptyTranscribe);
  }

  // looking + counting: SAM hazards and counts on the request frames.
  // Optional like picturing: on a SAM failure, log it, mark masks
  // unavailable (segmentation null), and continue to reason with no
  // segmentation counts instead of failing the run.
  assertNotAborted(deps.signal);
  emit("looking");
  emit("counting");
  let segmentation: Awaited<ReturnType<typeof runSegment>> | null = null;
  try {
    segmentation = await runSegment(
      {
        frames: request.frames.map((f) => ({
          tSec: f.tSec,
          dataUrl: f.dataUrl,
          ...(f.zoneId !== undefined ? { zoneId: f.zoneId } : {}),
        })),
        concurrency: deps.segmentConcurrency,
      },
      { ...deps.segment, signal: deps.signal },
    );
  } catch (err) {
    if (isAbort(err)) throw err;
    // A cap breach is not a SAM failure: stop the run instead of
    // continuing to the reason step, which would spend another call.
    if (isSpikeCapError(err))
      throw new PlanStepError("counting", PLAIN_FAILURE_MESSAGE.counting, detailOf(err));
    console.warn(`runPlan: segment failed, continuing without segmentation: ${detailOf(err)}`);
    segmentation = null;
    // The segment stage covers both UI steps, so both read as
    // skipped from here on; the next running line carries them.
    skippedSteps.push("looking", "counting");
  }

  // Server log only: whether the SAM request cap bit on this run.
  // No plan output, no UI change. This is the evidence the held
  // SAM-cap decision needs from the next real Large/XL run.
  if (segmentation) {
    const segmentBudget = formatSegmentBudget(
      request.frames.length,
      segmentation.requestsMade,
      segmentation.flaggedFrames.length,
      segmentation.budgetExceeded,
      segmentation.droppedLabels,
    );
    if (segmentBudget) console.log(segmentBudget);
  }

  // comparing: Spark turns frames + segmentation + transcript into
  // issues, materials, and work steps. When the reason step is
  // capped (Baseten mode), it sees only the picked subset, in
  // subset positions, and its output is remapped back to plan
  // frames before assembly; the meta path is untouched.
  assertNotAborted(deps.signal);
  emit("comparing");
  const reasonSubset = deps.reasonMaxFrames
    ? pickReasonFrames(
        request.frames.length,
        segmentation?.flaggedFrames ?? [],
        deps.reasonMaxFrames,
        request.frames.map((f) => f.zoneId),
      )
    : null;
  // Server log only: whether the capped reason subset actually saw
  // every area. No plan output, no UI change. This is the evidence
  // the held SAM-cap decision needs from the next real Large/XL run:
  // if zones are left out here, the reason step never saw them.
  if (reasonSubset) {
    const subsetZones = formatReasonSubsetZones(
      request.frames.map((f) => f.zoneId),
      reasonSubset,
    );
    if (subsetZones) console.log(subsetZones);
    const subsetFlagged = formatReasonSubsetFlagged(
      segmentation?.flaggedFrames ?? [],
      reasonSubset,
    );
    if (subsetFlagged) console.log(subsetFlagged);
    const subsetSpacing = formatReasonSubsetSpacing(
      request.frames.map((f) => f.tSec),
      reasonSubset,
    );
    if (subsetSpacing) console.log(subsetSpacing);
  }
  // Segmentation indices are subset positions too, so the prompt's
  // flaggedFrames, hazardHits, and rawLog stay consistent with the
  // subset frame list; entries outside the subset are dropped.
  const reasonSegmentation =
    segmentation && reasonSubset
      ? {
          ...segmentation,
          flaggedFrames: segmentation.flaggedFrames
            .map((f) => reasonSubset.indexOf(f))
            .filter((p) => p >= 0),
          hazardHits: segmentation.hazardHits
            ?.map((hit) => {
              const pos = reasonSubset.indexOf(hit.frameIndex);
              return pos < 0 ? null : { ...hit, frameIndex: pos };
            })
            .filter((hit): hit is NonNullable<typeof hit> => hit !== null),
          rawLog: segmentation.rawLog
            .map((entry) => {
              const pos = reasonSubset.indexOf(entry.frameIndex);
              return pos < 0 ? null : { ...entry, frameIndex: pos };
            })
            .filter((entry): entry is NonNullable<typeof entry> => entry !== null),
        }
      : segmentation;
  let reason;
  try {
    const reasonInput: ReasonInput = {
      frames: (reasonSubset ? reasonSubset.map((i) => request.frames[i]) : request.frames).map(
        (f) => ({
          tSec: f.tSec,
          dataUrl: f.dataUrl,
          ...(f.zoneId !== undefined ? { zoneId: f.zoneId } : {}),
        }),
      ),
      segmentation: reasonSegmentation,
      transcript,
      spaceName: request.spaceName,
      spaceType: request.spaceType,
      durationSec: request.durationSec,
    };
    const reasonDeps: ReasonDeps = deps.reasonPrompt
      ? { ...deps.reason, prompt: deps.reasonPrompt(reasonInput), signal: deps.signal }
      : { ...deps.reason, signal: deps.signal };
    const rawReason = await runReason(reasonInput, reasonDeps);
    reason = reasonSubset ? remapReasonOutput(rawReason, reasonSubset) : rawReason;
    // Server log only: whether the remap dropped any reason output.
    // No plan output, no UI change. The subset lines above show what
    // the reason step saw; this line shows what survived coming back.
    if (reasonSubset) {
      const remapDropped = formatReasonRemapDropped(
        rawReason.issues.length,
        reason.issues.length,
        (rawReason.watch ?? []).length,
        (reason.watch ?? []).length,
      );
      if (remapDropped) console.log(remapDropped);
    }
    console.log(formatReasonStability(reasonSegmentation, reason));
    if (reason.warnings?.length) {
      console.warn(`runPlan: reason kept with warnings:\n${reason.warnings.join("\n")}`);
    }
  } catch (err) {
    if (isAbort(err)) throw err;
    throw new PlanStepError("comparing", PLAIN_FAILURE_MESSAGE.comparing, detailOf(err));
  }

  // counting + comparing checks: the reason output is the first
  // point where both are computable (the inventory carries the SAM
  // method, the issues carry the mentioned flag), so both checks land
  // here, before planning uses the reason output. Counting follows
  // stepChecks.ts: only when segmentation ran and the inventory
  // actually carries SAM outlines; a failed segment step gets no
  // counting check, as on the finished plan. Comparing only when
  // the run was narrated.
  if (
    segmentation !== null &&
    reason.inventory.length > 0 &&
    reason.inventory.some((i) => i.method === "sam" || i.method === "sam+model")
  ) {
    const noOutline = reason.inventory.filter(
      (i) => i.method !== "sam" && i.method !== "sam+model",
    ).length;
    emit(
      "counting",
      noOutline === 0
        ? { ok: true, note: "Counts match the outlines" }
        : {
            ok: false,
            note: `${noOutline} ${noOutline === 1 ? "count" : "counts"} had no outline, marked estimated`,
          },
    );
    // Server log only: whether any count lacked a SAM outline.
    // No plan output, no UI change. The processing screen shows
    // the same note, but this line is the server-log record.
    const countingOutlines = formatCountingOutlines(
      reason.inventory.length,
      noOutline,
    );
    if (countingOutlines) console.log(countingOutlines);
  }
  if (Boolean(transcript?.trim()) || transcriptTurns.length > 0) {
    const said = reason.issues.filter((i) => !i.unmentioned).length;
    const notSaid = reason.issues.length - said;
    emit("comparing", { ok: true, note: `${said} you mentioned, ${notSaid} you didn't` });
  }

  // planning: region-grounded cost range (null without a region),
  // then assemble the plan shell the render step edits from.
  // Cost is optional (2026-10-27 2:15 PM review): when a region
  // was given but the cost call fails, log a server warning, keep
  // costRange null, and set meta.skipped.cost, instead of failing
  // the run. A run with no region sets no flag, and a contract-
  // check failure still fails the run.
  assertNotAborted(deps.signal);
  emit("planning");
  const frames: PlanFrame[] = request.frames.map((f, i) => ({
    index: i,
    tSec: f.tSec,
    url: f.dataUrl,
  }));
  let cost: Awaited<ReturnType<typeof estimateCost>> = null;
  let costSkipped = false;
  try {
    const costInput: CostInput = {
      spaceName: reason.spaceName,
      generatedFrom: reason.generatedFrom,
      inventory: reason.inventory,
      issues: reason.issues,
      materials: reason.materials,
      workOrder: reason.workOrder,
      region: request.region,
      laborBasis: request.laborBasis,
    };
    const costDeps: CostDeps =
      deps.costPrompt && request.region?.trim()
        ? { ...deps.cost, prompt: deps.costPrompt(costInput, request.spaceType), signal: deps.signal }
        : { ...deps.cost, signal: deps.signal };
    cost = await estimateCost(costInput, costDeps);
    // Server log only: whether the cost step priced and grounded
    // every material. No plan output, no UI change.
    if (cost) {
      const costPricing = formatCostPricing(
        cost.materials.length,
        cost.pricedMaterials,
        cost.groundedPrices,
      );
      if (costPricing) console.log(costPricing);
    }
  } catch (err) {
    if (isAbort(err)) throw err;
    // A cap breach is not a cost failure: stop the run instead of
    // continuing to the picturing step, which would spend another call.
    if (isSpikeCapError(err))
      throw new PlanStepError("planning", PLAIN_FAILURE_MESSAGE.planning, detailOf(err));
    // No-region estimateCost returns null without calling, so a throw
    // here is unexpected: keep the old planning failure, don't mask it.
    if (!request.region?.trim()) {
      throw new PlanStepError("planning", PLAIN_FAILURE_MESSAGE.planning, detailOf(err));
    }
    console.warn(`runPlan: cost failed, continuing without cost range: ${detailOf(err)}`);
    costSkipped = true;
    cost = null;
  }
  let draft: WorkPlan;
  try {
    draft = {
      spaceName: reason.spaceName,
      generatedFrom: reason.generatedFrom,
      inventory: reason.inventory,
      issues: reason.issues,
      watch: reason.watch,
      coverageNote: reason.coverageNote ?? undefined,
      materials: cost ? cost.materials : reason.materials,
      workOrder: reason.workOrder,
      afterImageUrl: null,
      transcript,
      frames,
      transcriptTurns,
      transcriptSummary: reason.transcriptSummary,
      saidVsSeen: reason.saidVsSeen,
      costRange: cost
        ? { ...cost.costRange, pricing: { priced: cost.pricedMaterials, grounded: cost.groundedPrices } }
        : null,
      heroFrameIndex: reason.heroFrameIndex,
      meta: planMeta(segmentation === null, false, costSkipped, transcribeSkipped),
    };
    const errs = checkWorkPlan(draft);
    // A reason result kept with warnings (2026-10-27 9:55 AM review)
    // may still fail the attached-frames contract check on those same
    // fields; those errors are logged, not thrown. Any error not
    // explained by a reason warning still fails the run.
    const unexplained = errs.filter((e) => !explainedByReasonWarnings(e, reason.warnings ?? []));
    if (unexplained.length > 0) {
      throw new Error(`runPlan: plan failed contract check:\n${unexplained.join("\n")}`);
    }
    // Server log only: the explained errors above, which the run
    // kept (see the helper note). No plan output, no UI change.
    const explainedDraftErrors = formatExplainedContractErrors(errs, reason.warnings ?? []);
    if (explainedDraftErrors) console.warn(explainedDraftErrors);
  } catch (err) {
    if (isAbort(err)) throw err;
    if (err instanceof PlanStepError) throw err;
    throw new PlanStepError("planning", PLAIN_FAILURE_MESSAGE.planning, detailOf(err));
  }

  // planning check: the draft is the first full plan, so its own
  // planning entry from stepChecks.ts is exact here (proof-frame
  // coverage), and it lands before picturing uses the draft.
  {
    const planningCheck = stepChecksForPlan(draft).planning;
    if (planningCheck) emit("planning", planningCheck);
  }

  // picturing: render the finished space, or null when skipped/failed.
  // runRenderAfter never throws for a model failure; it returns null
  // with a skip reason, so a failed render still yields a full plan.
  // An AbortError still propagates, so a stopped run stops instead
  // of shipping a plan with a silently skipped picture.
  assertNotAborted(deps.signal);
  emit("picturing");
  // Time-limit skip (2026-11-03 live run cut at 312 s before
  // picturing): past ~230 s the Image call plus the review call
  // would push the run past the 300 s host limit, so skip both and
  // ship the plan — no call, no cost — with meta.skipped.afterImage
  // and a ran:false review below, instead of no plan at all. A
  // time-skipped picturing arrives only via the done plan's
  // meta.skipped, like every other picturing skip (see above).
  const picturingTimeSkipped = picturingTimeLimitExceeded(runStartedAtMs);
  if (picturingTimeSkipped) {
    console.log(
      `runPlan: picturing skipped: time-limit (elapsed ${Date.now() - runStartedAtMs} ms)`,
    );
  }
  const rendered: Awaited<ReturnType<typeof runRenderAfter>> = picturingTimeSkipped
    ? { afterImageUrl: null, heroFrameIndex: null, visibleChanges: [] }
    : await runRenderAfter(
        { plan: draft, spaceType: request.spaceType },
        { ...deps.renderAfter, signal: deps.signal },
      );
  // afterImage is skipped when picturing was time-skipped or when the
  // render step itself produced no image; both ride the same flag.
  const afterImageSkipped = picturingTimeSkipped || rendered.skipped !== undefined;
  // Server log only: why the after picture was skipped, when it was.
  // No plan output, no UI change. The finished plan's meta.skipped
  // keeps only a boolean, so without this line a real run never says
  // whether picturing skipped cleanly, failed on the model, or hit
  // the spike cap — the cases spike tracking needs apart.
  const picturingSkipped = formatPicturingSkipped(rendered.skipped);
  if (picturingSkipped) console.log(picturingSkipped);

  const plan: WorkPlan = {
    ...draft,
    afterImageUrl: rendered.afterImageUrl,
    ...(rendered.afterImageUrl ? { afterImageLabel: AFTER_IMAGE_LABEL } : {}),
    heroFrameIndex: rendered.heroFrameIndex ?? reason.heroFrameIndex,
    meta: planMeta(segmentation === null, afterImageSkipped, costSkipped, transcribeSkipped),
  };
  const errs = checkWorkPlan(plan);
  const unexplained = errs.filter((e) => !explainedByReasonWarnings(e, reason.warnings ?? []));
  if (unexplained.length > 0) {
    throw new PlanStepError(
      "planning",
      PLAIN_FAILURE_MESSAGE.planning,
      `runPlan: final plan failed contract check:\n${unexplained.join("\n")}`,
    );
  }
  // Server log only: the explained errors above, which the run
  // kept (see the helper note). No plan output, no UI change.
  const explainedFinalErrors = formatExplainedContractErrors(errs, reason.warnings ?? []);
  if (explainedFinalErrors) console.warn(explainedFinalErrors);
  // picturing check: only when an after picture was actually made,
  // matching stepChecks.ts (a skipped render gets no picturing entry).
  {
    const picturingCheck = stepChecksForPlan(plan).picturing;
    if (picturingCheck) emit("picturing", picturingCheck);
  }

  // reviewing: the review-only reviewer pass (prompt 06), only when
  // the route wired it (review + reviewPrompt together). It runs
  // after picturing, or after planning when picturing was skipped,
  // because the plan is final by then either way. It never fails a
  // run: runReview returns ran:false on any call, validation, or cap
  // failure, and the plan still ships with "Review didn't run".
  // When the review dep is absent, the run ends here with no review
  // field, as before, and the processing screen's Reviewing row
  // simply completes when the done plan arrives. When picturing was
  // time-skipped (above), reviewing is skipped too — the call would
  // push the run past the host limit — and the plan below ships the
  // same "Review didn't run" shape instead.
  if (deps.review && deps.reviewPrompt && !picturingTimeSkipped) {
    assertNotAborted(deps.signal);
    emit("reviewing");
    const photos = buildReviewPhotos(plan.issues, plan.frames ?? []);
    // Server log only: whether the reviewer saw a proof photo for
    // every issue. No plan output, no UI change. This is the
    // evidence for whether the 8-photo review cap left an issue
    // unseen on a real run.
    const reviewCoverage = formatReviewCoverage(
      plan.issues,
      photos.map((photo) => photo.frameIndex),
    );
    if (reviewCoverage) console.log(reviewCoverage);
    let review: Awaited<ReturnType<typeof runReview>>;
    try {
      review = await runReview(
        {
          issues: plan.issues,
          frames: photos.map((photo) => ({
            frameIndex: photo.frameIndex,
            dataUrl: (plan.frames ?? [])[photo.frameIndex].url,
          })),
        },
        {
          prompt: deps.reviewPrompt({
            spaceType: request.spaceType,
            issues: plan.issues,
            photos,
          }),
          schema: REVIEW_SCHEMA,
          callSpark: deps.review.callSpark,
          tracker: deps.tracker,
          signal: deps.signal,
        },
      );
    } catch (err) {
      if (isAbort(err)) throw err;
      // runReview throws only for bad deps (already validated above),
      // so anything here is a late wiring bug: log it and ship the
      // finished plan with "Review didn't run" rather than failing
      // the run at its last step.
      console.warn(`runPlan: review failed unexpectedly, continuing without review: ${detailOf(err)}`);
      review = { ran: false, items: [] };
    }
    // Server log only: what the reviewer verdicts say. No plan
    // output, no UI change. The finished plan carries review.ran and
    // review.items, but no one-line summary of which issues the
    // reviewer failed to verify, so without this line a real run
    // never says at a glance whether reviewing backed the plan.
    const reviewVerdicts = formatReviewVerdicts(
      review,
      plan.issues.map((issue) => issue.rank),
    );
    if (reviewVerdicts) console.log(reviewVerdicts);
    // The final plan's meta was computed before reviewing (above), so
    // recompute it here: otherwise the review call's spend and model
    // would be missing from meta.costUsd / meta.models on every
    // reviewed run, and the run-cost line would undercount.
    return {
      ...plan,
      meta: planMeta(segmentation === null, afterImageSkipped, costSkipped, transcribeSkipped),
      review: review.ran ? { ...review, source: "model" as const } : review,
    };
  }
  // Time-limit skip: reviewing is skipped with picturing, so the
  // plan ships the same "Review didn't run" shape a failed review
  // ships — no call, no cost — instead of no plan at all.
  if (picturingTimeSkipped && deps.review && deps.reviewPrompt) {
    return { ...plan, review: { ran: false, items: [] } };
  }
  return plan;
}



