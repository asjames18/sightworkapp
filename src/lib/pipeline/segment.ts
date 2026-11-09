/**
 * SightWork pipeline step: `segment`.
 *
 * Runs the SAM 3.1 concept list from the prompt 02 spec
 * over the sampled frames and turns the masks
 * into the segmentation result the reason step consumes. SAM is
 * prompted with short noun phrases, not instructions, so the "prompt"
 * here is the concept list plus the aggregation rules from prompt 02.
 *
 * This module makes no API calls and holds no keys. The SAM caller is
 * injected by the wiring code (later: src/lib/meta), so the step is
 * testable on mock data and the spike can swap callers without
 * touching this logic. Every would-be call is recorded on the usage
 * tracker from ./usage.ts, so the $10 spike cap is enforced in code.
 *
 * Aggregation rules (prompt 02, enforced here, not trusted to the
 * model):
 * - Request budget (rule 1, rewritten Oct 26): hazards get 60% of
 *   the cap on evenly spaced frames, scene-change frames first
 *   (22 by default); counts run on an evenly spaced subset of those
 *   hazard frames (17 by default), except that when zoneIds are
 *   given the count subset keeps at least one frame per zone (the
 *   middle of its longest run), filled evenly — otherwise a short
 *   zone at the end of the walk gets no count frame and adds 0
 *   (finding B, Oct 29). Short videos whose frames x
 *   hazard concepts fit in 60% of the cap get hazards on every
 *   frame and the count pass takes the rest, as before.
 * - If the count pass still gets fewer than 6 frames, drop plants,
 *   then screens, before shrinking the hazard share. budgetExceeded
 *   is set only when the split had to drop concepts.
 * - "exit sign" is in both lists, so it is run once (in the hazard
 *   pass) and the result is reused for the count pass; no second call.
 * - Counts are summed across zones, never across frames in one zone
 *   (frames overlap as the camera pans). For each concept, a zone's
 *   count = the max instance count seen in any single count frame
 *   in that zone; total = the sum of the per-zone maxima, floored
 *   at the whole-video single-frame max. Confidence = the mean SAM
 *   score of the instances in each zone's best frame, rounded to 2
 *   decimals. A label whose total is 0 is omitted. Frames without a
 *   zoneId form their own zone (omit zoneId everywhere and the take
 *   is one zone, as before); a numbered zone never merges with
 *   unzoned frames.
 * - flaggedFrames = sorted, unique indices of frames with at least
 *   one hazard-concept instance at or above minScore.
 * - hazardHits = for each flagged frame and hazard key, the
 *   best-scoring instance's box, when it has one. reason.ts does not
 *   consume hazardHits yet; they are carried here so the reason step
 *   can reuse them as proofFrames[].box later without a new call.
 * - The per-frame raw results are returned as rawLog for the
 *   server-side debug log. They never go into WorkPlan.
 *
 * The result type is SegmentationResult from ./reason.ts, extended
 * with the optional hazardHits and the run diagnostics, so a segment
 * output can be handed straight to runReason.
 */

import type { Box, HazardKey } from "../types";
import type { SegmentationResult } from "./reason";
import { recordFailedCall, type UsageTracker } from "./usage";

/** Model ID from prompt 02; confirm it at the first spike. */
export const SAM_MODEL = "sam-3.1";

/** Instance score threshold from prompt 02. Drop instances below it. */
export const DEFAULT_MIN_SCORE = 0.5;

/** Request cap per plan from prompt 02 (one request = one concept on one frame). */
export const DEFAULT_MAX_SAM_REQUESTS = 300;

/**
 * Default SAM concurrency: at most this many SAM calls in flight at
 * once. Serial runs made the 120-call real walkthrough pass the
 * slowest step; a 4-wide pool is the timing win without letting a
 * burst of calls hit the model endpoint at once.
 */
export const DEFAULT_SEGMENT_CONCURRENCY = 4;

/** Max decoded bytes per segment frame, same shape as the SAM caller's 5 MB image cap. */
const MAX_SEGMENT_IMAGE_BYTES = 5 * 1024 * 1024;

/** One SAM concept: the noun phrase sent to the model and its output label. */
export interface CountConcept {
  /** Noun phrase sent to SAM, e.g. "folding table". */
  prompt: string;
  /** Label shown in counts[] and the UI, e.g. "Folding tables". */
  label: string;
}

/** One hazard concept: the noun phrase sent to SAM and the key it flags. */
export interface HazardConcept {
  /** Noun phrase sent to SAM, e.g. "cable on floor". */
  prompt: string;
  /** HazardKey reason uses to decide whether a real issue exists. */
  hazard: HazardKey;
}

/** Default count concepts from prompt 02, in output order. */
export const COUNT_CONCEPTS: CountConcept[] = [
  { prompt: "chair", label: "Chairs" },
  { prompt: "folding table", label: "Folding tables" },
  { prompt: "ceiling light fixture", label: "Ceiling light fixtures" },
  { prompt: "exit sign", label: "Exit signs" },
  { prompt: "loudspeaker", label: "Speakers" },
  { prompt: "projection screen", label: "Screens" },
  { prompt: "potted plant", label: "Plants" },
  { prompt: "stage platform", label: "Stage platform sections" },
];

/** Default hazard concepts from prompt 02. */
export const HAZARD_CONCEPTS: HazardConcept[] = [
  { prompt: "cable on floor", hazard: "trip_cable" },
  { prompt: "extension cord", hazard: "trip_cable" },
  { prompt: "power strip", hazard: "power_strip" },
  { prompt: "water stain", hazard: "water_stain" },
  { prompt: "exposed wire", hazard: "exposed_wiring" },
  { prompt: "torn chair upholstery", hazard: "damaged_seating" },
  { prompt: "fire extinguisher", hazard: "fire_extinguisher" },
  { prompt: "exit sign", hazard: "egress" },
];

/**
 * Concepts dropped from the count pass to fit the request cap, in the
 * order prompt 02 drops them: plants first, then screens. A drop only
 * counts when it actually buys a count pass; otherwise the count pass
 * is skipped and nothing is dropped.
 */
export const COUNT_DROP_ORDER: string[] = ["Plants", "Screens"];

/** One SAM instance as the caller returns it (unknown shape, validated here). */
export interface RawInstance {
  /** SAM instance score, 0-1. */
  score: number;
  /** Box already normalized to 0-1000 [x1, y1, x2, y2]; the SAM caller normalizes pixels. */
  box?: Box;
}

/** A model call supplied by the wiring code. Never a real call in tests. */
export interface SegmentCaller {
  (req: {
    model: string;
    /** Noun-phrase concept, e.g. "chair". */
    concept: string;
    /** Index into the plan's frames array. */
    frameIndex: number;
    /** Data URL of the still image. */
    dataUrl: string;
    /**
     * Abort signal for a stopped run (2026-11-01): when set, the
     * SAM caller passes it to its fetch, and an already-aborted
     * signal throws an AbortError before any fetch, so a stopped
     * run never starts (or pays for) a SAM call it no longer needs.
     */
    signal?: AbortSignal;
  }): Promise<{ instances: unknown; latencyMs: number; costUsd: number }>;
}

/** One frame handed to the segment step, in array order. */
export interface SegmentFrame {
  tSec: number;
  /** Data URL of the still image, attached to the model call in order. */
  dataUrl: string;
  /**
   * Browser zone id from PlanRequest.frames (proposal B): frames
   * from the same physical area share one small integer from 0.
   * Omit it and the frame joins the unzoned zone; omit it on every
   * frame and the take counts as one zone, as before.
   */
  zoneId?: number;
}

export interface SegmentInput {
  frames: SegmentFrame[];
  /** Indices of scene-change frames, kept first in the count subset. */
  sceneFrameIndices?: number[];
  minScore?: number;
  maxRequests?: number;
  /** At most this many SAM calls in flight; default DEFAULT_SEGMENT_CONCURRENCY. */
  concurrency?: number;
}

/** One hazard hit: the best instance for a hazard key on a frame. */
export interface HazardHit {
  frameIndex: number;
  hazard: HazardKey;
  score: number;
  box: Box;
}

/** One per-frame raw result, for the server-side debug log only. */
export interface SegmentRawEntry {
  concept: string;
  frameIndex: number;
  /** Instances at or above minScore. */
  count: number;
  boxes: Box[];
  scores: number[];
}

/** Segment output: the reason step's input, plus run diagnostics. */
export interface SegmentOutput extends SegmentationResult {
  /** Best-scoring hazard instance per frame and hazard key (box required). */
  hazardHits?: HazardHit[];
  /** Per-frame raw results; debug log only, never part of WorkPlan. */
  rawLog: SegmentRawEntry[];
  /** Count labels dropped to fit the request cap (empty when none). */
  droppedLabels: string[];
  /** Actual SAM calls made (reused "exit sign" results are not re-called). */
  requestsMade: number;
  /** True when the split had to drop concepts (or the cap fits no hazard frame). */
  budgetExceeded: boolean;
}

export interface SegmentDeps {
  callSegment: SegmentCaller;
  tracker: UsageTracker;
  /**
   * Abort signal for a stopped run, forwarded to every SAM call,
   * same shape as the transcribe/reason/cost/review/picturing legs.
   */
  signal?: AbortSignal;
}

/** Validate raw SAM output into instances, dropping nothing here (threshold applied by callers). */
export function parseInstances(raw: unknown, concept: string, frameIndex: number): RawInstance[] {
  if (!Array.isArray(raw)) {
    throw new Error(`segment: SAM output for "${concept}" on frame ${frameIndex} is not an instance array`);
  }
  const out: RawInstance[] = [];
  for (let i = 0; i < raw.length; i++) {
    const t = raw[i] as Record<string, unknown>;
    if (t === null || typeof t !== "object" || Array.isArray(t)) {
      throw new Error(`segment: instance ${i} for "${concept}" on frame ${frameIndex} is not an object`);
    }
    if (typeof t.score !== "number" || !Number.isFinite(t.score) || t.score < 0 || t.score > 1) {
      throw new Error(`segment: instance ${i} for "${concept}" on frame ${frameIndex} has no valid score`);
    }
    let box: Box | undefined;
    if (t.box !== undefined) {
      if (
        !Array.isArray(t.box) ||
        t.box.length !== 4 ||
        t.box.some((v) => typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1000)
      ) {
        throw new Error(`segment: instance ${i} for "${concept}" on frame ${frameIndex} has no valid 0-1000 box`);
      }
      const [x1, y1, x2, y2] = (t.box as number[]).map((v) => Math.round(v));
      if (x1 > x2 || y1 > y2) {
        throw new Error(`segment: instance ${i} for "${concept}" on frame ${frameIndex} has an inverted box`);
      }
      box = [x1, y1, x2, y2];
    }
    out.push(box === undefined ? { score: t.score } : { score: t.score, box });
  }
  return out;
}

export interface SegmentPlan {
  /** Hazard-pass frames: 60% of the cap, evenly spaced, scene-change frames first. */
  hazardFrames: number[];
  /**
   * Count-pass frames: an evenly spaced subset of hazardFrames,
   * except that when zoneIds are given every zone keeps at least
   * one frame (see evenlySpacedCoveringZones).
   */
  countFrames: number[];
  /** Count labels dropped to fit the cap (empty when none). */
  droppedLabels: string[];
  /** Planned SAM calls, counting the shared "exit sign" once. */
  requestsPlanned: number;
  /** True when the split had to drop concepts (or the cap fits no hazard frame). */
  budgetExceeded: boolean;
}

function dedupePrompts(prompts: string[]): string[] {
  return [...new Set(prompts)];
}

function validateSceneIndices(indices: number[], frameCount: number): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  for (const i of indices) {
    if (!Number.isInteger(i) || i < 0 || i >= frameCount) {
      throw new Error(`segment: scene frame index ${i} is out of range for ${frameCount} frames`);
    }
    if (!seen.has(i)) {
      seen.add(i);
      out.push(i);
    }
  }
  return out.sort((a, b) => a - b);
}

/** Evenly spaced picks from candidates, up to count, in ascending order. */
function evenlySpaced(candidates: number[], count: number): number[] {
  if (count <= 0 || candidates.length === 0) return [];
  if (count >= candidates.length) return [...candidates];
  const picked: number[] = [];
  for (let i = 0; i < count; i++) {
    picked.push(candidates[Math.floor((i * candidates.length) / count)]);
  }
  return [...new Set(picked)].sort((a, b) => a - b);
}

/** Zone key for a frame index: its zoneId, or "u" when unzoned (unzoned frames form their own zone, as in the per-zone count sum). */
function zoneKey(zoneId: number | undefined): string {
  return typeof zoneId === "number" ? String(zoneId) : "u";
}

/**
 * Evenly spaced picks that keep at least one frame per zone
 * (finding B, Oct 29): one representative per zone — the middle
 * of its longest run of consecutive candidates, a steady view
 * rather than a cut frame — then the remaining slots filled
 * evenly. When there are more zones than slots, the zones with
 * the most candidate frames win (earlier zone on a tie). With no
 * zoneIds, or a single zone, this is exactly evenlySpaced, so a
 * take without zones plans exactly as before. Pipeline-local
 * copy of the same rule as client zoneCoverage.coverZones, kept
 * here so the server step does not import client code.
 * zoneIds is indexed by frame index, as candidates are frame indices.
 */
function evenlySpacedCoveringZones(
  candidates: number[],
  zoneIds: (number | undefined)[],
  count: number,
): number[] {
  if (count <= 0 || candidates.length === 0) return [];
  if (count >= candidates.length) return [...candidates];
  const hasZone = candidates.some((i) => typeof zoneIds[i] === "number");
  const zoneKeys = new Set(candidates.map((i) => zoneKey(zoneIds[i])));
  if (!hasZone || zoneKeys.size <= 1) return evenlySpaced(candidates, count);

  const runs = new Map<string, { best: number[]; cur: number[] }>();
  let prevKey: string | null = null;
  for (const idx of candidates) {
    const k = zoneKey(zoneIds[idx]);
    let z = runs.get(k);
    if (!z) runs.set(k, (z = { best: [], cur: [] }));
    if (k !== prevKey) z.cur = [];
    z.cur.push(idx);
    if (z.cur.length > z.best.length) z.best = [...z.cur];
    prevKey = k;
  }
  let reps = [...runs.values()].map((z) => z.best[Math.floor((z.best.length - 1) / 2)]);
  if (reps.length > count) {
    const size = (r: number) =>
      candidates.filter((i) => zoneKey(zoneIds[i]) === zoneKey(zoneIds[r])).length;
    reps = reps
      .map((r, order) => ({ r, order, n: size(r) }))
      .sort((a, b) => b.n - a.n || a.order - b.order)
      .slice(0, count)
      .map((x) => x.r);
  }
  const chosen = new Set(reps);
  const rest = candidates.filter((i) => !chosen.has(i));
  for (const i of evenlySpaced(rest, count - chosen.size)) chosen.add(i);
  return [...chosen].sort((a, b) => a - b);
}

/**
 * Plan the SAM request budget for a frame count (prompt 02, rule 1).
 * Hazards get 60% of the cap on evenly spaced frames, scene-change
 * frames first; counts run on an evenly spaced subset of those
 * hazard frames. When frames x hazard prompts fits in 60% of the
 * cap, hazards run on every frame and the count pass takes the
 * rest, as before. If the count pass still gets fewer than 6
 * frames, drop plants, then screens, before shrinking the hazard
 * share. budgetExceeded is set only when the split had to drop
 * concepts (or the cap fits no hazard frame at all).
 */
export function planSegmentFrames(opts: {
  frameCount: number;
  sceneFrameIndices?: number[];
  maxRequests?: number;
  /** One entry per frame, indexed by frame index; omit for an unzoned take. */
  zoneIds?: (number | undefined)[];
}): SegmentPlan {
  // A direct caller bypassing runSegment's input validation used to
  // get a raw TypeError here: null opts reading .frameCount, a
  // non-array sceneFrameIndices that is not iterable, or a null
  // zoneIds reading .length. Fail fast with named segment errors,
  // the same named-error rule the rest of this module follows.
  // Valid inputs are unchanged.
  if (opts === null || typeof opts !== "object" || Array.isArray(opts)) {
    throw new Error("segment: planSegmentFrames opts must be an object");
  }
  if (
    opts.sceneFrameIndices !== undefined &&
    !Array.isArray(opts.sceneFrameIndices)
  ) {
    throw new Error("segment: sceneFrameIndices must be an array when given");
  }
  if (opts.zoneIds !== undefined && !Array.isArray(opts.zoneIds)) {
    throw new Error("segment: zoneIds must be an array when given");
  }
  const frameCount = opts.frameCount;
  const maxRequests = opts.maxRequests ?? DEFAULT_MAX_SAM_REQUESTS;
  if (!Number.isInteger(frameCount) || frameCount < 0) {
    throw new Error(`segment: frameCount must be a whole number >= 0, got ${frameCount}`);
  }
  if (!Number.isInteger(maxRequests) || maxRequests < 0) {
    throw new Error(`segment: maxRequests must be a whole number >= 0, got ${maxRequests}`);
  }
  if (opts.zoneIds !== undefined) {
    if (opts.zoneIds.length !== frameCount) {
      throw new Error(`segment: zoneIds must have ${frameCount} entries, got ${opts.zoneIds.length}`);
    }
    for (let i = 0; i < opts.zoneIds.length; i++) {
      const z = opts.zoneIds[i];
      if (z !== undefined && (!Number.isInteger(z) || z < 0)) {
        throw new Error(`segment: frame ${i} zoneId must be a whole number >= 0`);
      }
    }
  }
  const scene = validateSceneIndices(opts.sceneFrameIndices ?? [], frameCount);
  const allFrames = Array.from({ length: frameCount }, (_, i) => i);

  const hazardPrompts = dedupePrompts(HAZARD_CONCEPTS.map((c) => c.prompt));
  const countPrompts = dedupePrompts(COUNT_CONCEPTS.map((c) => c.prompt));
  const shared = new Set(hazardPrompts.filter((p) => countPrompts.includes(p)));
  // Incremental count prompts exclude prompts already run in the hazard pass.
  const incrementalCount = (droppedLabels: string[]): number =>
    COUNT_CONCEPTS.filter(
      (c) => !shared.has(c.prompt) && !droppedLabels.includes(c.label),
    ).length;

  // Scene-change frames first, then evenly spaced fills up to count.
  const pickFrames = (count: number): number[] => {
    const rest = allFrames.filter((i) => !scene.includes(i));
    const fill = evenlySpaced(rest, Math.max(0, count - scene.length));
    return [...scene.slice(0, count), ...fill]
      .sort((a, b) => a - b)
      .slice(0, count);
  };

  // Hazard share: 60% of the cap. A short video (frames x hazards
  // fits in 60%) keeps hazards on every frame via the min().
  let hazardFrames = pickFrames(
    Math.min(frameCount, Math.floor((0.6 * maxRequests) / hazardPrompts.length)),
  );
  if (frameCount > 0 && hazardFrames.length === 0) {
    // Degenerate cap: no hazard frame fits the 60% share, so run
    // nothing rather than blow the cap; the caller reports it.
    return {
      hazardFrames: [],
      countFrames: [],
      droppedLabels: [],
      requestsPlanned: 0,
      budgetExceeded: true,
    };
  }
  let hazardRequests = hazardPrompts.length * hazardFrames.length;

  // Count pass on an evenly spaced subset of the hazard frames.
  // Reusing "exit sign" means it is never run twice on one frame.
  const countFramesFor = (droppedLabels: string[]): number => {
    const n = incrementalCount(droppedLabels);
    if (n === 0) return hazardFrames.length;
    return Math.min(
      hazardFrames.length,
      Math.floor((maxRequests - hazardRequests) / n),
    );
  };

  let droppedLabels: string[] = [];
  let countBudget = countFramesFor([]);
  // Fewer than 6 count frames, on a video with at least 6 frames:
  // drop plants, then screens, keeping a drop only when it actually
  // buys count frames. A shorter video already counts on every
  // frame, so there is nothing to fix and nothing is dropped.
  if (countBudget < 6 && frameCount >= 6) {
    for (const drop of [["Plants"], ["Plants", "Screens"]]) {
      const n = countFramesFor(drop);
      if (n > countBudget) {
        droppedLabels = drop;
        countBudget = n;
      }
      if (countBudget >= 6) break;
    }
    // Still fewer than 6: shrink the hazard share until the count
    // pass fits, or hazard frames run out.
    while (countBudget < 6 && hazardFrames.length > 1) {
      hazardFrames = pickFrames(hazardFrames.length - 1);
      hazardRequests = hazardPrompts.length * hazardFrames.length;
      countBudget = countFramesFor(droppedLabels);
    }
  }
  const countFrames = evenlySpacedCoveringZones(hazardFrames, opts.zoneIds ?? [], countBudget);

  return {
    hazardFrames,
    countFrames,
    droppedLabels,
    requestsPlanned:
      hazardRequests + incrementalCount(droppedLabels) * countFrames.length,
    budgetExceeded: droppedLabels.length > 0,
  };
}

/**
 * True when the string is valid base64, by the same rule the route
 * validator uses (src/lib/pipeline/planRequest.ts): base64 alphabet
 * plus up to two padding chars, length a multiple of 4, whitespace
 * ignored. Used only by validateSegmentInput below.
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

/** Validate the segment step's request before any paid SAM call. */
export function validateSegmentInput(input: SegmentInput): void {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("segment: input is not an object");
  }
  if (!Array.isArray(input.frames)) {
    throw new Error("segment: frames is not an array");
  }
  const minScore = input.minScore ?? DEFAULT_MIN_SCORE;
  if (typeof minScore !== "number" || !Number.isFinite(minScore) || minScore < 0 || minScore > 1) {
    throw new Error(`segment: minScore must be 0-1, got ${minScore}`);
  }
  if (
    input.maxRequests !== undefined &&
    (!Number.isInteger(input.maxRequests) || input.maxRequests < 0)
  ) {
    throw new Error(`segment: maxRequests must be a whole number >= 0, got ${input.maxRequests}`);
  }
  if (
    input.concurrency !== undefined &&
    (!Number.isInteger(input.concurrency) || input.concurrency < 1)
  ) {
    throw new Error(`segment: concurrency must be a whole number >= 1, got ${input.concurrency}`);
  }
  if (input.sceneFrameIndices !== undefined) {
    if (
      !Array.isArray(input.sceneFrameIndices) ||
      input.sceneFrameIndices.some((i) => !Number.isInteger(i))
    ) {
      throw new Error("segment: sceneFrameIndices is not an array of integers");
    }
  }
  for (let i = 0; i < input.frames.length; i++) {
    const f = input.frames[i];
    if (
      f === null ||
      typeof f !== "object" ||
      typeof f.tSec !== "number" ||
      !Number.isFinite(f.tSec) ||
      f.tSec < 0 ||
      typeof f.dataUrl !== "string" ||
      f.dataUrl.trim().length === 0
    ) {
      throw new Error(`segment: frame ${i} has no valid tSec/dataUrl`);
    }
    if (
      f.zoneId !== undefined &&
      (!Number.isInteger(f.zoneId) || f.zoneId < 0)
    ) {
      throw new Error(`segment: frame ${i} zoneId must be a whole number >= 0`);
    }
    // Parity with the route validator (src/lib/pipeline/planRequest.ts)
    // and validateRunPlanRequest/validateReasonRequest: a frame
    // dataUrl must be a data:image base64 URL carrying a real image
    // header. A bare string, a data:text URL, garbage base64, or a
    // text blob re-labelled as an image used to pass here and only
    // surface later, when paid SAM calls were spent on garbage
    // input, while the route already rejected the same input. A
    // direct runSegment caller gets the same fail-fast here instead
    // of only via the route.
    if (
      !f.dataUrl.startsWith("data:image/") ||
      !f.dataUrl.includes(";base64,")
    ) {
      throw new Error(
        `segment: frame ${i} dataUrl must be a data:image base64 URL`,
      );
    }
    {
      const payload = f.dataUrl.slice(f.dataUrl.indexOf(";base64,") + 8);
      if (payload.length === 0 || !isBase64(payload)) {
        throw new Error(
          `segment: frame ${i} dataUrl must carry valid base64 image data`,
        );
      }
      if (!isImageBase64(payload)) {
        throw new Error(
          `segment: frame ${i} dataUrl must carry image data (JPEG, PNG, WebP, or GIF)`,
        );
      }
      // Same shape as the SAM caller's 5 MB image cap and the reason
      // step's frame cap: the segment frames are 1024 px JPEGs, but
      // an over-cap frame here only surfaces at the SAM caller on
      // the first call, after request budgeting, with a "sam:"
      // error. Reject it at validation instead, before any SAM
      // call, so a direct runSegment caller fails fast with the
      // frame index. 5 MB decoded is wide headroom over a 1024 px
      // JPEG frame, so no valid request changes.
      {
        const stripped = payload.replace(/\s/g, "");
        const padding = stripped.endsWith("==") ? 2 : stripped.endsWith("=") ? 1 : 0;
        const decodedBytes = (stripped.length * 3) / 4 - padding;
        if (decodedBytes > MAX_SEGMENT_IMAGE_BYTES) {
          throw new Error(
            `segment: frame ${i} dataUrl must be at most 5 MB, got ${decodedBytes} bytes`,
          );
        }
      }
    }
  }
}

/** Validate the segment step's call deps before any paid SAM call. */
export function validateSegmentDeps(deps: SegmentDeps): void {
  if (deps === null || typeof deps !== "object" || Array.isArray(deps)) {
    throw new Error("segment: deps is not an object");
  }
  if (typeof deps.callSegment !== "function") {
    throw new Error("segment: callSegment is not a function");
  }
  if (
    deps.tracker === null ||
    typeof deps.tracker !== "object" ||
    typeof deps.tracker.record !== "function"
  ) {
    throw new Error("segment: tracker.record is not a function");
  }
}

/**
 * Run tasks with at most `limit` in flight, results in task order.
 * A task rejection stops the pool: tasks already in flight finish
 * (they cannot be cancelled), but no worker starts another task, so
 * when the usage tracker throws on the spike cap, at most limit-1
 * extra calls may already be in flight (a few cents at SAM prices,
 * and the run still stops). Previously Promise.all let the surviving
 * workers keep draining the queue after a rejection, so a cap throw
 * could keep spending calls that would each throw at record time.
 * Workers swallow their own errors and the first one is rethrown
 * after all workers settle, so no rejection is ever unhandled.
 */
export async function runWithConcurrency<T>(
  tasks: Array<() => Promise<T>>,
  limit: number,
): Promise<T[]> {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`segment: concurrency must be a whole number >= 1, got ${limit}`);
  }
  // The pool reads tasks.length and calls each entry, so a non-array
  // or a non-function entry would otherwise surface as a raw
  // TypeError from inside a worker, hiding the caller and the cause
  // behind the same named-error rule the limit check above follows.
  // Reject both up front, before any worker starts.
  if (!Array.isArray(tasks)) {
    throw new Error(`segment: tasks must be an array of functions, got ${tasks === null ? "null" : typeof tasks}`);
  }
  for (let i = 0; i < tasks.length; i++) {
    if (typeof tasks[i] !== "function") {
      throw new Error(`segment: task ${i} must be a function, got ${typeof tasks[i]}`);
    }
  }
  const results: T[] = new Array(tasks.length);
  let next = 0;
  let failed = false;
  let firstError: unknown;
  let hasError = false;
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    while (!failed && next < tasks.length) {
      const i = next;
      next += 1;
      try {
        results[i] = await tasks[i]();
      } catch (err) {
        failed = true;
        if (!hasError) {
          hasError = true;
          firstError = err;
        }
        return;
      }
    }
  });
  await Promise.all(workers);
  if (hasError) throw firstError;
  return results;
}

export async function runSegment(
  input: SegmentInput,
  deps: SegmentDeps,
): Promise<SegmentOutput> {
  validateSegmentInput(input);
  const minScore = input.minScore ?? DEFAULT_MIN_SCORE;

  const plan = planSegmentFrames({
    frameCount: input.frames.length,
    sceneFrameIndices: input.sceneFrameIndices,
    maxRequests: input.maxRequests,
    zoneIds: input.frames.map((f) => f.zoneId),
  });
  if (input.frames.length === 0) {
    return {
      counts: [],
      flaggedFrames: [],
      hazardHits: [],
      rawLog: [],
      droppedLabels: [],
      requestsMade: 0,
      budgetExceeded: false,
    };
  }
  // After the no-frames skip but before the first SAM call, so a bad
  // tracker no longer throws only after a paid call, when record runs.
  validateSegmentDeps(deps);

  const concurrency = input.concurrency ?? DEFAULT_SEGMENT_CONCURRENCY;
  const rawLog: SegmentRawEntry[] = [];
  let requestsMade = 0;
  // Keyed "prompt|frameIndex": the hazard pass fills it, the count pass reuses it.
  const results = new Map<string, RawInstance[]>();

  // One SAM call plus its usage record and parse/filter. Assembly
  // into results/rawLog happens in planned task order after the
  // pool finishes, so output order matches the old serial run.
  const makeCall = async (
    concept: string,
    frameIndex: number,
  ): Promise<{ concept: string; frameIndex: number; kept: RawInstance[] }> => {
    let res: Awaited<ReturnType<SegmentCaller>>;
    try {
      res = await deps.callSegment({
        model: SAM_MODEL,
        concept,
        frameIndex,
        dataUrl: input.frames[frameIndex].dataUrl,
        signal: deps.signal,
      });
    } catch (err) {
      // A billed-but-failed SAM call still spent money (e.g. MetaCallError
      // on a non-JSON response): record it before rethrowing, so the
      // route total counts it. A tracker throw (spike cap) replaces it
      // as a spending stop, same pattern as transcribe/reason/cost;
      // the pool stops on the rethrow, so no later pass runs.
      recordFailedCall(deps.tracker, SAM_MODEL, "segment", err);
      throw err;
    }
    // The tracker enforces the spike cap: a throw here stops the run.
    deps.tracker.record({
      model: SAM_MODEL,
      step: "segment",
      latencyMs: res.latencyMs,
      costUsd: res.costUsd,
    });
    const kept = parseInstances(res.instances, concept, frameIndex).filter(
      (inst) => inst.score >= minScore,
    );
    return { concept, frameIndex, kept };
  };
  const assemble = (
    done: Array<{ concept: string; frameIndex: number; kept: RawInstance[] }>,
  ): void => {
    for (const r of done) {
      results.set(`${r.concept}|${r.frameIndex}`, r.kept);
      rawLog.push({
        concept: r.concept,
        frameIndex: r.frameIndex,
        count: r.kept.length,
        boxes: r.kept.flatMap((inst) => (inst.box === undefined ? [] : [inst.box])),
        scores: r.kept.map((inst) => inst.score),
      });
    }
    requestsMade += done.length;
  };

  // Hazard pass: every unique hazard prompt on every frame, bounded pool.
  const hazardPrompts = dedupePrompts(HAZARD_CONCEPTS.map((c) => c.prompt));
  const hazardTasks = hazardPrompts.flatMap((prompt) =>
    plan.hazardFrames.map(
      (frameIndex) => () => makeCall(prompt, frameIndex),
    ),
  );
  assemble(await runWithConcurrency(hazardTasks, concurrency));

  // Count pass: surviving count concepts on the planned subset, reusing
  // any prompt already run in the hazard pass ("exit sign").
  const activeCounts = COUNT_CONCEPTS.filter((c) => !plan.droppedLabels.includes(c.label));
  const countTasks: Array<() => Promise<{ concept: string; frameIndex: number; kept: RawInstance[] }>> = [];
  for (const concept of activeCounts) {
    for (const frameIndex of plan.countFrames) {
      if (!results.has(`${concept.prompt}|${frameIndex}`)) {
        countTasks.push(() => makeCall(concept.prompt, frameIndex));
      }
    }
  }
  assemble(await runWithConcurrency(countTasks, concurrency));

  // Per-zone best frame per concept: the zone key is the frame's
  // zoneId, or "unzoned" when the client sent none (unzoned frames
  // share one zone but never merge with a numbered zone). Ties keep
  // the earliest frame, as the old single-zone max did.
  const zoneKeyFor = (frameIndex: number): string => {
    const z = input.frames[frameIndex].zoneId;
    return z === undefined ? "unzoned" : `zone:${z}`;
  };
  const perZone = new Map<
    string,
    Map<string, { frameIndex: number; count: number; scores: number[] }>
  >();
  for (const concept of activeCounts) {
    const zones = new Map<string, { frameIndex: number; count: number; scores: number[] }>();
    for (const frameIndex of plan.countFrames) {
      const kept = results.get(`${concept.prompt}|${frameIndex}`) ?? [];
      const key = zoneKeyFor(frameIndex);
      const prev = zones.get(key);
      if (prev === undefined || kept.length > prev.count) {
        zones.set(key, {
          frameIndex,
          count: kept.length,
          scores: kept.map((inst) => inst.score),
        });
      }
    }
    perZone.set(concept.label, zones);
  }

  const counts = activeCounts
    .map((concept) => {
      const zones = perZone.get(concept.label);
      if (zones === undefined) return null;
      let total = 0;
      let scoreSum = 0;
      let scoreCount = 0;
      let floor = 0;
      for (const best of zones.values()) {
        total += best.count;
        scoreSum += best.scores.reduce((a, b) => a + b, 0);
        scoreCount += best.scores.length;
        if (best.count > floor) floor = best.count;
      }
      if (total === 0) return null;
      // The sum already meets the floor when zones partition the
      // frames (a single frame sits in exactly one zone); the max
      // guards the count anyway, per proposal B.
      total = Math.max(total, floor);
      return {
        label: concept.label,
        count: total,
        confidence: Math.round((scoreSum / scoreCount) * 100) / 100,
      };
    })
    .filter((c) => c !== null);

  // Hazard aggregation: best instance per frame and hazard key.
  const flagged = new Set<number>();
  const bestHit = new Map<string, HazardHit>();
  const hazardOrder = new Map<HazardKey, number>();
  HAZARD_CONCEPTS.forEach((c, i) => {
    if (!hazardOrder.has(c.hazard)) hazardOrder.set(c.hazard, i);
  });
  for (const concept of HAZARD_CONCEPTS) {
    for (const frameIndex of plan.hazardFrames) {
      const kept = results.get(`${concept.prompt}|${frameIndex}`) ?? [];
      if (kept.length === 0) continue;
      flagged.add(frameIndex);
      const best = kept.reduce((a, b) => (b.score > a.score ? b : a));
      if (best.box === undefined) continue;
      const key = `${frameIndex}|${concept.hazard}`;
      const prev = bestHit.get(key);
      if (prev === undefined || best.score > prev.score) {
        bestHit.set(key, {
          frameIndex,
          hazard: concept.hazard,
          score: best.score,
          box: best.box,
        });
      }
    }
  }
  const hazardHits = [...bestHit.values()].sort(
    (a, b) =>
      a.frameIndex - b.frameIndex ||
      (hazardOrder.get(a.hazard) ?? 0) - (hazardOrder.get(b.hazard) ?? 0),
  );

  return {
    counts,
    flaggedFrames: [...flagged].sort((a, b) => a - b),
    hazardHits,
    rawLog,
    droppedLabels: plan.droppedLabels,
    requestsMade,
    budgetExceeded: plan.budgetExceeded,
  };
}
