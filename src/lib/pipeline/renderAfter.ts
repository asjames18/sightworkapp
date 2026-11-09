/**
 * SightWork pipeline step: `renderAfter`.
 *
 * Takes the WorkPlan from the reason step (prompt 03) and produces the
 * "after" image: a Muse Image edit of the hero frame showing only the
 * finished, visible work (prompt 04
 * spec).
 *
 * This module makes no API calls and holds no keys. The image caller is
 * injected by the wiring code (later: src/lib/meta), so the step is
 * testable on mock data and the spike can swap callers without touching
 * this logic. Every would-be call is recorded on the usage tracker from
 * ./usage.ts, so the $10 spike cap is enforced in code.
 *
 * Rules (prompt 04, enforced here, not trusted to the model):
 * - Hero frame: plan.heroFrameIndex when set and in range; otherwise the
 *   frameIndex of the highest-ranked issue whose fix is visible; otherwise
 *   the frame closest to the middle of the video. Whatever is picked is
 *   returned as heroFrameIndex so the wiring can write it back to the
 *   plan and the UI shows the right "before" frame. If the picked frame
 *   has no visible changes, the step falls back to the highest-ranked
 *   issue frame that does (recomputing the changes) before skipping:
 *   a reason step that points at a frame with nothing to fix must not
 *   silently drop the after image when a ranked issue frame has work.
 * - Visible changes only: issues that appear in the hero frame
 *   (frameIndex or a proof frame), and only the work steps that fix them
 *   and describe something seen (paint, cables, chairs, lights, signs,
 *   tiles). Inspections and hidden work (inside walls, above ceilings)
 *   are skipped. If the list is empty, no model call is made.
 * - Failure returns null: on any model failure the step returns
 *   afterImageUrl null, because the UI already has a placeholder slot.
 *   A judge failure is the exception: the optional judge only picks
 *   between two good candidates, so a bad judge answer keeps the first
 *   candidate instead of discarding a valid image.
 *   A billed judge failure is recorded on the tracker before that
 *   fallback, so the route total counts it; a tracker throw on the
 *   record is warned, not a spending stop, as in the review step.
 * - afterImageUrl is null (never omitted or an empty string) when the
 *   image is skipped or fails, and afterImageLabel is set only when an
 *   image exists, per the plan-screen contract.
 *
 * Model IDs are not hardcoded here: prompt 04 says to confirm them at
 * the first spike, so the wiring supplies imageModel (and judgeModel
 * when the judge runs) through deps.
 *
 * Fail-fast validation (same series as reason.ts): the input shape is
 * validated before any work, and the call deps are validated after the
 * skip checks but before any paid Image call, so a bad request never
 * spends a call. A bad request throws with a clear reason: error; the
 * skip paths (no frames, no visible changes, unusable hero URL) still
 * return null without needing valid call deps, because no call is made.
 */

import { AFTER_IMAGE_LABEL, type WorkPlan, type WorkStep } from "../types";
import { recordFailedCall, type UsageTracker } from "./usage";

/** Muse Image edit of the hero frame. Never a real call in tests. */
export interface ImageCaller {
  (req: {
    model: string;
    prompt: string;
    /** Data URL (or URL) of the hero frame to edit. */
    image: string;
    /** Candidates wanted; 1 unless the wiring asks for 2. */
    n?: number;
    /**
     * Abort signal for a stopped run (2026-11-01): forwarded to
     * the image caller. An aborted signal there throws an
     * AbortError, which this step rethrows (see runRenderAfter)
     * instead of reporting a model failure.
     */
    signal?: AbortSignal;
  }): Promise<{ images: string[]; latencyMs: number; costUsd: number }>;
}

/** Spark judge for the optional generate-2-keep-1 path. */
export interface JudgeCaller {
  (req: {
    model: string;
    prompt: string;
    /** [original, candidate 1, candidate 2], in that order. */
    images: [string, string, string];
    /**
     * Abort signal for a stopped run (2026-11-01): forwarded to
     * the judge caller; an aborted judge call rethrows instead
     * of falling back to the first candidate.
     */
    signal?: AbortSignal;
  }): Promise<{ json: unknown; latencyMs: number; costUsd: number }>;
}

export interface RenderAfterInput {
  plan: WorkPlan;
  spaceType?: string;
}

export interface RenderAfterDeps {
  /** Muse Image model ID, confirmed at the first spike. */
  imageModel: string;
  callImage: ImageCaller;
  /** Abort signal from runPlan (the route's request signal), forwarded to callImage/callJudge. */
  signal?: AbortSignal;
  /** Optional judge; required when generateTwo is true. */
  judgeModel?: string;
  callJudge?: JudgeCaller;
  /** When true, ask for 2 candidates and let the judge pick one. */
  generateTwo?: boolean;
  tracker: UsageTracker;
}

export interface RenderAfterOutput {
  afterImageUrl: string | null;
  afterImageLabel?: typeof AFTER_IMAGE_LABEL;
  /** The hero frame used, or null when there was no frame to edit. */
  heroFrameIndex: number | null;
  /** Finished-state lines sent to the model (empty when skipped). */
  visibleChanges: string[];
  /** Why no image was produced, when afterImageUrl is null. */
  skipped?: "no-frames" | "no-visible-changes" | "model-failure" | "cap-exceeded";
  /** Plain failure detail for the server log; never shown in the UI. */
  error?: string;
}

const DEFAULT_SPACE_TYPE = "room";

const KEEP_LIST =
  "camera angle, framing, room layout, architecture, windows, lighting direction, existing furniture positions, signage text, existing logos, emblems, banners and wall art exactly as they are (same shapes, letters and colours; do not redraw, re-letter or move them)";

/** Fixes that show in a photo (prompt 04's visible list, plus covers). */
const VISIBLE_RE =
  /\b(paint|repaint|cable|chair|light|sign|tile|carpet|flooring|door|window|cover|seating|pew|table)\b/i;

/** Fixes that cannot be seen in a photo. */
const INVISIBLE_RE =
  /\b(inspect|inspection|check above|above the ceiling|inside (a |the )?wall|behind (a |the )?wall|in-wall|under the floor|ceiling cavity|test (the )?wiring)\b/i;

function isVisibleStep(step: WorkStep): boolean {
  const text = `${step.title} ${step.detail}`;
  return VISIBLE_RE.test(text);
}

/** A step describes hidden work only when it matches INVISIBLE_RE and no visible keyword. */
function isHiddenStep(step: WorkStep): boolean {
  const text = `${step.title} ${step.detail}`;
  return INVISIBLE_RE.test(text) && !VISIBLE_RE.test(text);
}

/**
 * Pick the hero frame: plan.heroFrameIndex when in range, else the
 * highest-ranked issue with a visible fix, else the frame closest to
 * the middle of the video. Null when the plan has no frames.
 */
export function pickHeroFrameIndex(plan: WorkPlan): number | null {
  if (!plan || typeof plan !== "object") {
    throw new Error("renderAfter: plan must be an object");
  }
  const frames = plan.frames;
  if (frames !== undefined && !Array.isArray(frames)) {
    throw new Error("renderAfter: plan.frames must be an array when given");
  }
  if (!frames || frames.length === 0) return null;
  const inRange = (i: number | undefined) =>
    typeof i === "number" && Number.isInteger(i) && i >= 0 && i < frames.length;
  if (inRange(plan.heroFrameIndex)) return plan.heroFrameIndex as number;

  // The ranked pick below spreads issues and filters workOrder, so a
  // direct caller bypassing runRenderAfter's input validation used to
  // get a raw TypeError here with no step name. Valid plans pass
  // through unchanged: runRenderAfter already requires both arrays.
  if (!Array.isArray(plan.issues)) {
    throw new Error("renderAfter: plan.issues must be an array");
  }
  if (!Array.isArray(plan.workOrder)) {
    throw new Error("renderAfter: plan.workOrder must be an array");
  }
  // Parity with the array guards above: a non-object issues or
  // workOrder entry used to pass here and only fail in the ranked
  // pick below, reading rank off null in the sort comparator (or
  // fixes off null in the filter) with a raw TypeError and no entry
  // named. Fail fast here, with the index named.
  plan.issues.forEach((issue, i) => {
    if (!issue || typeof issue !== "object") {
      throw new Error(`renderAfter: plan.issues[${i}] must be an object`);
    }
  });
  plan.workOrder.forEach((s, i) => {
    if (!s || typeof s !== "object") {
      throw new Error(`renderAfter: plan.workOrder[${i}] must be an object`);
    }
  });
  const ranked = [...plan.issues].sort((a, b) => a.rank - b.rank);
  for (const issue of ranked) {
    const fixing = plan.workOrder.filter((s) => s.fixes?.includes(issue.rank));
    if (fixing.some((s) => isVisibleStep(s)) && inRange(issue.frameIndex)) {
      return issue.frameIndex;
    }
  }

  const maxT = Math.max(...frames.map((f) => f.tSec));
  let best = frames[0].index;
  let bestDist = Math.abs(frames[0].tSec - maxT / 2);
  for (const f of frames) {
    const dist = Math.abs(f.tSec - maxT / 2);
    if (dist < bestDist) {
      best = f.index;
      bestDist = dist;
    }
  }
  return best;
}

/**
 * Finished-state lines for the hero frame: one per visible work step
 * that fixes an issue appearing in this frame. The step title is the
 * line (the prompt 04 spec sets the wording); duplicate steps collapse.
 * Empty when nothing visible changes in this frame.
 */
/**
 * Fallback hero when the picked frame has no visible changes: the
 * frameIndex of the highest-ranked issue (rank ascending) that is not
 * the tried frame, exists in plan.frames, and yields a non-empty
 * visible-changes list. Null when no ranked issue frame qualifies, so
 * the caller keeps the original hero and reports the skip.
 */
export function pickFallbackHeroFrameIndex(plan: WorkPlan, tried: number): number | null {
  // Same named-error rule as pickHeroFrameIndex: a direct caller
  // bypassing runRenderAfter's input validation used to get a raw
  // TypeError from the sort below, reading rank off a null entry, or
  // from .some on a non-array frames list. Valid plans pass through
  // unchanged: runRenderAfter already requires both arrays.
  if (!plan || typeof plan !== "object") {
    throw new Error("renderAfter: plan must be an object");
  }
  if (!Array.isArray(plan.issues)) {
    throw new Error("renderAfter: plan.issues must be an array");
  }
  if (plan.frames !== undefined && !Array.isArray(plan.frames)) {
    throw new Error("renderAfter: plan.frames must be an array when given");
  }
  plan.issues.forEach((issue, i) => {
    if (!issue || typeof issue !== "object") {
      throw new Error(`renderAfter: plan.issues[${i}] must be an object`);
    }
  });
  const ranked = [...plan.issues].sort((a, b) => a.rank - b.rank);
  const seen = new Set<number>([tried]);
  for (const issue of ranked) {
    const candidate = issue.frameIndex;
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    if (!plan.frames?.some((f) => f.index === candidate)) continue;
    if (buildVisibleChanges(plan, candidate).length > 0) return candidate;
  }
  return null;
}

export function buildVisibleChanges(plan: WorkPlan, hero: number): string[] {
  // A non-object plan, or a non-array issues/workOrder list, would
  // otherwise throw a raw TypeError from .filter below, with no step
  // name — the same named-error rule pickHeroFrameIndex above follows.
  // Valid plans pass through unchanged: runRenderAfter already
  // requires both arrays.
  if (!plan || typeof plan !== "object") {
    throw new Error("renderAfter: plan must be an object");
  }
  if (!Array.isArray(plan.issues)) {
    throw new Error("renderAfter: plan.issues must be an array");
  }
  if (!Array.isArray(plan.workOrder)) {
    throw new Error("renderAfter: plan.workOrder must be an array");
  }
  // Parity with pickHeroFrameIndex above: a non-object entry used to
  // pass here and only fail in the filter below, reading frameIndex
  // off null (or fixes off null in the step filter) with a raw
  // TypeError and no entry named. Fail fast here, with the index named.
  plan.issues.forEach((issue, i) => {
    if (!issue || typeof issue !== "object") {
      throw new Error(`renderAfter: plan.issues[${i}] must be an object`);
    }
  });
  plan.workOrder.forEach((s, i) => {
    if (!s || typeof s !== "object") {
      throw new Error(`renderAfter: plan.workOrder[${i}] must be an object`);
    }
  });
  const heroIssues = plan.issues.filter(
    (issue) =>
      issue.frameIndex === hero ||
      issue.proofFrames?.some((p) => p.frameIndex === hero),
  );
  const lines: string[] = [];
  for (const issue of [...heroIssues].sort((a, b) => a.rank - b.rank)) {
    for (const step of plan.workOrder.filter((s) => s.fixes?.includes(issue.rank))) {
      if (isHiddenStep(step)) continue;
      const line = step.title.trim();
      if (line && !lines.includes(line)) lines.push(line);
    }
  }
  return lines;
}

/**
 * Validate a prompt builder's inputs before it emits a prompt: a
 * blank space type used to produce "this exact  photo", a non-array
 * changes list threw a bare TypeError on .map, an empty list produced
 * a prompt with an empty "Change only" section (a paid Image call
 * that asks for nothing), and a non-string/blank entry leaked
 * "undefined" into the prompt. A newline inside a change entry used
 * to print as a second, unbulleted line in the Change only list — a
 * line the image model could read as an extra requested change — so
 * such entries now fail fast. Valid inputs pass through verbatim,
 * so prompts built from good input are unchanged.
 */
function validatePromptChanges(visibleChanges: unknown, caller: string): void {
  if (!Array.isArray(visibleChanges) || visibleChanges.length === 0) {
    throw new Error(`renderAfter: ${caller} needs a non-empty visibleChanges array`);
  }
  visibleChanges.forEach((c, i) => {
    if (typeof c !== "string" || c.trim().length === 0) {
      throw new Error(`renderAfter: ${caller} visibleChanges[${i}] must be a non-empty string`);
    }
    if (/[\r\n]/.test(c)) {
      throw new Error(`renderAfter: ${caller} visibleChanges[${i}] must not contain a newline`);
    }
  });
}

/** The prompt-04 edit prompt, with space type, keep list, and changes filled. */
export function buildRenderAfterPrompt(spaceType: string, visibleChanges: string[]): string {
  if (typeof spaceType !== "string" || spaceType.trim().length === 0) {
    throw new Error("renderAfter: buildRenderAfterPrompt spaceType must be a non-empty string");
  }
  if (/[\r\n]/.test(spaceType)) {
    throw new Error("renderAfter: buildRenderAfterPrompt spaceType must not contain a newline");
  }
  validatePromptChanges(visibleChanges, "buildRenderAfterPrompt");
  const changes = visibleChanges.map((c) => `- ${c}`).join("\n");
  return (
    `Photo edit of this exact ${spaceType} photo. Show the same room after the work is done.\n` +
    `Keep identical: ${KEEP_LIST}.\n` +
    `Change only:\n${changes}\n` +
    `Photorealistic, same time of day, same lens. Do not add people, text, logos, or decorations that were not asked for. Leave any existing logo or lettering untouched; if it is too small to copy exactly, leave that area of the photo as it is. Do not change anything not listed.`
  );
}

/** The prompt-04 judge prompt for two candidates. */
export function buildJudgePrompt(visibleChanges: string[]): string {
  validatePromptChanges(visibleChanges, "buildJudgePrompt");
  const changes = visibleChanges.map((c) => `- ${c}`).join("\n");
  return (
    `Image 1 is the original photo. Images 2 and 3 are edits that should show only these changes:\n${changes}\n` +
    `Which edit keeps the room most faithful (same angle, layout, architecture) while clearly showing the changes? ` +
    `Answer with JSON: {"pick": 2 or 3, "reason": "<one sentence>"}` 
  );

}

function isBase64(value: string): boolean {
  const stripped = value.replace(/\s/g, "");
  return /^[A-Za-z0-9+/]*={0,2}$/.test(stripped) && stripped.length % 4 === 0;
}

/**
 * True when the base64 string decodes to a real image header, by the
 * same magic-byte rule the Image caller uses: JPEG (FF D8 FF),
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
 * True when a string is an image this step can use. Non-data URLs
 * (http(s), relative) pass through as before — they cannot be
 * checked without fetching. A data: URL must be an image: SVG data
 * URLs (the mock/example frames) pass as before, but any other image
 * data URL must be base64 carrying a real raster header. A data:text
 * URL, garbage base64, or a text blob re-labelled as an image used
 * to pass the old "starts with data:" check, reach the Image caller,
 * and surface as a model failure, while the Image caller itself now
 * rejects the same input before any paid call.
 */
function isUsableImage(s: unknown): s is string {
  if (typeof s !== "string" || s.length === 0) return false;
  if (!s.startsWith("data:")) return true;
  if (s.startsWith("data:image/svg+xml")) return true;
  if (!s.startsWith("data:image/") || !s.includes(";base64,")) return false;
  const payload = s.slice(s.indexOf(";base64,") + 8);
  return payload.length > 0 && isBase64(payload) && isImageBase64(payload);
}

/**
 * Max hero-frame size from prompt 04 (5 MB decoded), same bound as the
 * reason/segment step caps and the Image caller.
 */
const MAX_RENDER_AFTER_IMAGE_BYTES = 5 * 1024 * 1024;

/**
 * Validate the renderAfter input shape before any work. Throws with a
 * clear reason: error; a bad plan used to surface as a TypeError inside
 * the hero pick or the visible-changes build instead, and a newline in
 * spaceType used to pass here and only fail at the prompt build, after
 * the hero pick and visible-changes work. A newline in a work-step title used to
 * do the same: the title is the prompt line,
 * so buildRenderAfterPrompt rejects it, but only after the hero pick
 * and visible-changes work. Hidden titles still pass,
 * since their lines never reach the prompt. A work-step title that
 * is not a string used to pass here and only fail later, as a raw
 * TypeError from .trim in the visible-changes build, so such titles
 * fail fast here with the step named. A non-object work-order entry is
 * the same fail-fast, matching the issues-entry guard: it used to pass
 * here and only fail later in buildVisibleChanges, reading fixes off
 * null with a raw TypeError and no step named. A non-array proofFrames
 * on an issues entry is the same fail-fast: it used to pass here and
 * only fail later in buildVisibleChanges, calling .some off a
 * non-array with a raw TypeError and no issue named. A non-array fixes
 * on a work-order entry is the same fail-fast: it used to pass here
 * and only fail later in buildVisibleChanges (and the hero pick),
 * calling .includes off a non-array with a raw TypeError and no step
 * named — or, for a string fixes, silently matching by substring.
 */
export function validateRenderAfterInput(input: RenderAfterInput): void {
  if (!input || typeof input !== "object") {
    throw new Error("renderAfter: input must be an object");
  }
  const plan = (input as RenderAfterInput).plan;
  if (!plan || typeof plan !== "object") {
    throw new Error("renderAfter: plan must be an object");
  }
  if (plan.frames !== undefined) {
    if (!Array.isArray(plan.frames)) {
      throw new Error("renderAfter: plan.frames must be an array when given");
    }
    plan.frames.forEach((f, i) => {
      if (
        !f ||
        typeof f !== "object" ||
        !Number.isInteger(f.index) ||
        (f.index as number) < 0 ||
        typeof f.tSec !== "number" ||
        !Number.isFinite(f.tSec) ||
        f.tSec < 0
      ) {
        throw new Error(`renderAfter: plan.frames[${i}] has no valid index/tSec`);
      }
      // Same shape as the reason/segment step caps: a direct
      // runRenderAfter caller bypassing runPlan had no bound on the
      // hero frame, so an unbounded data URL would ride onto a paid
      // Image call before any cap could stop it. 5 MB decoded is
      // wide headroom over a 1024 px JPEG frame; reject it here,
      // before any work. Non-data URLs pass (they cannot be sized
      // without fetching) and non-base64 payloads are left to the
      // usable-image skip path in runRenderAfter.
      if (
        typeof f.url === "string" &&
        f.url.startsWith("data:image/") &&
        f.url.includes(";base64,")
      ) {
        const payload = f.url.slice(f.url.indexOf(";base64,") + 8);
        const stripped = payload.replace(/\s/g, "");
        if (stripped.length > 0 && isBase64(stripped)) {
          const padding = stripped.endsWith("==") ? 2 : stripped.endsWith("=") ? 1 : 0;
          const decodedBytes = (stripped.length * 3) / 4 - padding;
          if (decodedBytes > MAX_RENDER_AFTER_IMAGE_BYTES) {
            throw new Error(
              `renderAfter: plan.frames[${i}].url must be at most 5 MB, got ${decodedBytes} bytes`,
            );
          }
        }
      }
    });
  }
  if (!Array.isArray(plan.issues)) {
    throw new Error("renderAfter: plan.issues must be an array");
  }
  // Parity with the work-step title guard: a non-object issues entry
  // used to pass this validator and only fail later in
  // buildVisibleChanges, reading frameIndex off null with a raw
  // TypeError and no issue named. Fail fast here, with the index named.
  plan.issues.forEach((issue, i) => {
    if (!issue || typeof issue !== "object") {
      throw new Error(`renderAfter: plan.issues[${i}] must be an object`);
    }
    // Parity with the issues-entry guard: a non-array proofFrames
    // used to pass this validator and only fail later in
    // buildVisibleChanges, calling .some off a non-array with a raw
    // TypeError and no issue named. Fail fast here, with the index named.
    if (issue.proofFrames !== undefined && !Array.isArray(issue.proofFrames)) {
      throw new Error(`renderAfter: plan.issues[${i}].proofFrames must be an array when given`);
    }
    // Parity with the proofFrames-array guard: a non-object entry
    // used to pass this validator and only fail later in
    // buildVisibleChanges, reading frameIndex off null with a raw
    // TypeError and no issue named (when the hero differs from the
    // issue's frameIndex, so the proof-frames check actually runs).
    // Fail fast here, with both indices named.
    if (Array.isArray(issue.proofFrames)) {
      issue.proofFrames.forEach((p, j) => {
        if (!p || typeof p !== "object") {
          throw new Error(`renderAfter: plan.issues[${i}].proofFrames[${j}] must be an object`);
        }
      });
    }
  });
  if (!Array.isArray(plan.workOrder)) {
    throw new Error("renderAfter: plan.workOrder must be an array");
  }
  if (
    input.spaceType !== undefined &&
    (typeof input.spaceType !== "string" || input.spaceType.trim().length === 0)
  ) {
    throw new Error("renderAfter: spaceType must be a non-empty string when given");
  }
  // Parity with buildRenderAfterPrompt (via validatePromptChanges): a
  // newline in a work-step title used to pass this validator
  // and only fail at the prompt build, after the hero pick and
  // visible-changes work. A direct validate-then-run caller gets the
  // same fail-fast here, before any work, with the step named. Only
  // titles that could reach the prompt are checked: buildVisibleChanges
  // lists every non-hidden step that fixes a hero issue, whether or
  // not it matches a visible keyword, so a non-visible, non-hidden
  // title (e.g. "Fix budget") becomes a prompt line too and is
  // checked here as well. Hidden titles never become prompt lines,
  // so they still pass.
  plan.workOrder.forEach((s, i) => {
    // Parity with the issues-entry guard above: a non-object
    // work-order entry used to pass this validator and only fail
    // later in buildVisibleChanges, reading fixes off null with a raw
    // TypeError and no step named. Fail fast here, with the index named.
    if (!s || typeof s !== "object") {
      throw new Error(`renderAfter: plan.workOrder[${i}] must be an object`);
    }
    if (s && typeof s === "object" && typeof s.title !== "string") {
      throw new Error(`renderAfter: plan.workOrder[${i}].title must be a string`);
    }
    if (
      s &&
      typeof s === "object" &&
      typeof s.title === "string" &&
      /[\r\n]/.test(s.title) &&
      !isHiddenStep(s)
    ) {
      throw new Error(`renderAfter: plan.workOrder[${i}].title must not contain a newline`);
    }
    // Parity with the issues-entry proofFrames guard: a non-array
    // fixes used to pass this validator and only fail later in
    // buildVisibleChanges (and the hero pick), calling .includes off
    // a non-array with a raw TypeError and no step named — or, for a
    // string fixes, silently matching by substring. Fail fast here,
    // with the index named. Omitted fixes still pass: a step that
    // fixes nothing is listed, just never matched to an issue.
    if (s.fixes !== undefined && !Array.isArray(s.fixes)) {
      throw new Error(`renderAfter: plan.workOrder[${i}].fixes must be an array when given`);
    }
  });
  // Parity with buildRenderAfterPrompt (prompt 04): a newline in the
  // space type used to pass this validator and only fail at the prompt
  // build, after the hero pick and visible-changes work. A direct
  // validate-then-run caller gets the same fail-fast here, before any
  // work, with the field named. Clean space types pass unchanged.
  if (
    typeof input.spaceType === "string" &&
    /[\r\n]/.test(input.spaceType)
  ) {
    throw new Error("renderAfter: spaceType must not contain a newline when given");
  }
}

/**
 * Validate the call deps before any paid Image call. Throws with a
 * clear reason: error. In particular, generateTwo without a judge
 * used to pay for 2 candidates and then pick the first anyway, since
 * the judge branch silently requires both callJudge and judgeModel.
 */
export function validateRenderAfterDeps(deps: RenderAfterDeps): void {
  if (!deps || typeof deps !== "object") {
    throw new Error("renderAfter: deps must be an object");
  }
  if (typeof deps.imageModel !== "string" || deps.imageModel.trim().length === 0) {
    throw new Error("renderAfter: imageModel must be a non-empty string");
  }
  if (typeof deps.callImage !== "function") {
    throw new Error("renderAfter: callImage must be a function");
  }
  if (!deps.tracker || typeof deps.tracker.record !== "function") {
    throw new Error("renderAfter: tracker.record must be a function");
  }
  if (deps.generateTwo === true) {
    if (typeof deps.judgeModel !== "string" || deps.judgeModel.trim().length === 0) {
      throw new Error("renderAfter: judgeModel must be a non-empty string when generateTwo is true");
    }
    if (typeof deps.callJudge !== "function") {
      throw new Error("renderAfter: callJudge must be a function when generateTwo is true");
    }
  }
}

export async function runRenderAfter(
  input: RenderAfterInput,
  deps: RenderAfterDeps,
): Promise<RenderAfterOutput> {
  validateRenderAfterInput(input);
  const { plan } = input;
  let hero = pickHeroFrameIndex(plan);
  if (hero === null) {
    return { afterImageUrl: null, heroFrameIndex: null, visibleChanges: [], skipped: "no-frames" };
  }
  let visibleChanges = buildVisibleChanges(plan, hero);
  if (visibleChanges.length === 0) {
    // The reason step's hero can point at a frame with nothing to
    // fix (real run 2026-10-29: hero 1, both ranked issues on frames
    // 6 and 5) while a ranked issue frame has visible work. Fall
    // back to that frame and recompute before giving up on the image.
    const fallback = pickFallbackHeroFrameIndex(plan, hero);
    if (fallback !== null) {
      hero = fallback;
      visibleChanges = buildVisibleChanges(plan, hero);
    }
  }
  if (visibleChanges.length === 0) {
    return {
      afterImageUrl: null,
      heroFrameIndex: hero,
      visibleChanges,
      skipped: "no-visible-changes",
    };
  }

  const heroFrame = plan.frames?.[hero];
  if (!heroFrame) {
    return {
      afterImageUrl: null,
      heroFrameIndex: hero,
      visibleChanges,
      skipped: "no-frames",
    };
  }
  if (
    typeof heroFrame.url !== "string" ||
    heroFrame.url.trim().length === 0 ||
    (heroFrame.url.startsWith("data:") && !isUsableImage(heroFrame.url))
  ) {
    // No usable image to edit: skip without spending a paid call. A
    // whitespace-only URL is unusable too: the old length check
    // accepted it, so it would have reached the image caller inside
    // the try and surfaced as a model failure instead of this clean skip.
    // Same for a malformed data: URL (data:text, garbage base64, or a
    // text blob re-labelled as an image): the Image caller now rejects
    // it before any paid call, so reaching it would only mislabel an
    // input problem as a model failure.
    return {
      afterImageUrl: null,
      heroFrameIndex: hero,
      visibleChanges,
      skipped: "no-frames",
      error: "renderAfter: hero frame has no usable image URL",
    };
  }

  // Fail fast here, after the skip paths and before the try: a
  // validation throw inside the try would be swallowed as a
  // "model-failure" null, hiding a wiring bug.
  validateRenderAfterDeps(deps);

  const spaceType = input.spaceType ?? DEFAULT_SPACE_TYPE;
  const prompt = buildRenderAfterPrompt(spaceType, visibleChanges);
  try {
    const wantTwo = deps.generateTwo === true;
    let res: Awaited<ReturnType<ImageCaller>>;
    try {
      res = await deps.callImage({
        model: deps.imageModel,
        prompt,
        image: heroFrame.url,
        n: wantTwo ? 2 : 1,
        signal: deps.signal,
      });
    } catch (err) {
      // A billed-but-failed image call still spent money (e.g. a
      // MetaCallError on a non-JSON response): record it before the
      // outer catch reports model-failure, so the route total counts
      // it. This closes the image leg of the failed-call series,
      // matching the judge leg below. A tracker throw (spike cap)
      // replaces it as a spending stop, and the outer catch then
      // reports cap-exceeded with no image.
      recordFailedCall(deps.tracker, deps.imageModel, "renderAfter", err);
      throw err;
    }
    deps.tracker.record({
      model: deps.imageModel,
      step: "renderAfter",
      latencyMs: res.latencyMs,
      costUsd: res.costUsd,
    });
    const candidates = res.images.filter(isUsableImage);
    if (candidates.length === 0) {
      return {
        afterImageUrl: null,
        heroFrameIndex: hero,
        visibleChanges,
        skipped: "model-failure",
        error: "renderAfter: image caller returned no usable image",
      };
    }
    let picked = candidates[0];
    if (wantTwo && candidates.length >= 2 && deps.callJudge && deps.judgeModel) {
      try {
        const judged = await deps.callJudge({
          model: deps.judgeModel,
          prompt: buildJudgePrompt(visibleChanges),
          images: [heroFrame.url, candidates[0], candidates[1]],
          signal: deps.signal,
        });
        deps.tracker.record({
          model: deps.judgeModel,
          step: "renderAfterJudge",
          latencyMs: judged.latencyMs,
          costUsd: judged.costUsd,
        });
        const pick = (judged.json as { pick?: unknown } | null)?.pick;
        if (pick === 3) picked = candidates[1];
        else if (pick !== 2) {
          // Bad judge answer: keep the first candidate, never drop a good image.
          picked = candidates[0];
        }
      } catch (err) {
        // A stopped run stops here too: an aborted judge call
        // must not fall back to the first candidate and ship an
        // image for a run the user stopped.
        if (err instanceof Error && err.name === "AbortError") throw err;
        // A billed-but-failed judge call still spent money (e.g. a
        // MetaCallError on a non-JSON response): record it before
        // falling back, so the route total counts it. A tracker
        // throw on the record is a failed judge, not a spending
        // stop — the image already exists, so the first candidate
        // still ships, as in the review step.
        try {
          if (deps.judgeModel) {
            recordFailedCall(deps.tracker, deps.judgeModel, "renderAfterJudge", err);
          }
        } catch (recErr) {
          console.warn(
            `renderAfter: judge usage record failed, keeping first candidate: ${recErr instanceof Error ? recErr.message : String(recErr)}`,
          );
        }
        // A spike-cap throw is a spending stop, not a bad judge
        // answer: rethrow it so the outer catch reports
        // cap-exceeded instead of silently returning a candidate
        // whose judge call already breached the cap.
        const message = err instanceof Error ? err.message : String(err);
        if (/spike cap/i.test(message)) throw err;
        picked = candidates[0];
      }
    }
    return {
      afterImageUrl: picked,
      afterImageLabel: AFTER_IMAGE_LABEL,
      heroFrameIndex: hero,
      visibleChanges,
    };
  } catch (err) {
    // A stopped run is a stop, not a model failure: an AbortError
    // from the image or judge call propagates, so runPlan and the
    // route treat it as a stop instead of shipping a plan with a
    // silently skipped after picture.
    if (err instanceof Error && err.name === "AbortError") throw err;
    const message = err instanceof Error ? err.message : String(err);
    const cap = /spike cap/i.test(message);
    return {
      afterImageUrl: null,
      heroFrameIndex: hero,
      visibleChanges,
      skipped: cap ? "cap-exceeded" : "model-failure",
      error: `renderAfter: ${message.slice(0, 200)}`,
    };
  }
}
