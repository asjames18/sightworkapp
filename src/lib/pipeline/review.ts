/**
 * SightWork pipeline step: `review` (the "reviewing" step).
 *
 * Takes a finished plan's issues and the proof photos that back
 * them, and asks a model to check each problem against the photos:
 * could it see the problem in at least one proof photo, and why, in
 * one plain sentence. Review-only: nothing here edits the plan, and
 * the result lands on `plan.review` for the plan screen's badge and
 * review line (src/lib/review.ts). The wiring run attaches it in
 * runPlan after picturing; this module only does the call.
 *
 * This module makes no API calls and holds no keys. The model caller
 * is injected, like the reason step's, so the step is testable on
 * mock data and the spike can swap callers without touching this
 * logic. Prompt and schema are injected too: the prompt wording
 * is prompt 06, built by the wiring code from the finished plan
 * (src/lib/reviewPrompt.ts), and the schema below mirrors
 * PlanReviewItem, so the caller sends the finished prompt the
 * wiring code built from the plan.
 *
 * Never fails a run. A call failure, a validation failure after one
 * retry, or a bad step input returns `{ ran: false, items: [] }`
 * (logged server-side with console.warn) instead of throwing, so a
 * finished plan still ships with "Review didn't run" rather than
 * dying at the last step. Only a bad dep (not an object, no
 * callSpark, no tracker.record) throws, like the reason step: that
 * is a wiring bug, not a runtime failure, and must fail fast in
 * development. A usage-tracker throw (the $10 spike cap) is a
 * runtime failure here, not a stop: reviewing is the last step, so
 * there is no later call to protect, and the finished plan stands
 * without its review.
 *
 * Every call is recorded on the usage tracker (step "review"), so
 * the spike cap and the $150 credit total see it, exactly like the
 * other steps. A billed-but-failed call is recorded too, before the
 * step returns REVIEW_NOT_RUN, so the route total counts its spend;
 * a tracker throw there is still just a failed review, not a stop.
 * A run with no issues spends no call (nothing to
 * check); a run with issues but no usable proof photos also spends
 * none (there is nothing for the reviewer to look at).
 */

import { parseReview, type PlanReview } from "../review";
import type { Issue } from "../types";
import { failedCallModel, recordFailedCall, type UsageTracker } from "./usage";

/** One proof photo handed to the reviewer, in attach order. */
export interface ReviewFrame {
  /** Index into the plan's frames, so the prompt can name it. */
  frameIndex: number;
  /** Data URL of the still image, attached to the model call in order. */
  dataUrl: string;
}

export interface ReviewInput {
  /** The plan's issues, in rank order. At least the rank, title, and detail ride into the prompt. */
  issues: Pick<Issue, "rank" | "title" | "detail" | "proofFrames">[];
  /** Proof photos to attach. Capped by the caller; this step checks the cap and rejects a repeated frame, so one photo never rides twice. */
  frames: ReviewFrame[];
}

/** A model call supplied by the wiring code. Never a real call in tests. */
export interface ReviewSparkCaller {
  (req: {
    model: string;
    prompt: string;
    images: string[];
    schema: Record<string, unknown>;
    /** Sampling temperature, forwarded verbatim when set. */
    temperature?: number;
    /**
     * Abort signal for a stopped run (2026-11-01): forwarded to the
     * model caller so stopping a run can cut the in-flight review
     * call short. Omit it and the call behaves exactly as before.
     */
    signal?: AbortSignal;
  }): Promise<{
    json: unknown;
    latencyMs: number;
    costUsd: number;
    /** Model the caller actually used; omitted means the requested one. */
    model?: string;
  }>;
}

export interface ReviewDeps {
  /** Prompt text (prompt 06), with the plan's issues and frame list already filled. */
  prompt: string;
  /** Structured-output schema for the review. REVIEW_SCHEMA below, unless the caller overrides it. */
  schema: Record<string, unknown>;
  callSpark: ReviewSparkCaller;
  tracker: UsageTracker;
  /** Abort signal from runPlan (the route's request signal), forwarded to callSpark. */
  signal?: AbortSignal;
}

const SPARK_MODEL = "muse-spark-1.3";
/** Deterministic structured output for the review call (2026-10-30 7:52 PM review). */
const SPARK_TEMPERATURE = 0.2;

/** Baseten image cap, same as the reason step: at most 8 images per request. */
export const MAX_REVIEW_IMAGES = 8;

/** Max decoded bytes per proof photo, same shape as the reason step's 5 MB image cap. */
const MAX_REVIEW_IMAGE_BYTES = 5 * 1024 * 1024;

/**
 * Structured-output schema for the review. The model answers one
 * verdict per problem: problemId is String(issue.rank), verified is
 * whether the problem is visible in at least one proof photo, reason
 * is one plain sentence (parseReview clips it to 140 characters).
 * ran is required, not optional: parseReview rejects any answer
 * without a boolean ran, so a schema without it made every
 * schema-following review fail validation and end as "Review didn't
 * run" (2026-10-30). summary is optional. No $defs, so no inlining
 * is needed.
 */
export const REVIEW_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["ran", "items"],
  properties: {
    ran: { type: "boolean" },
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["problemId", "verified", "reason"],
        properties: {
          problemId: { type: "string" },
          verified: { type: "boolean" },
          reason: { type: "string" },
        },
      },
    },
    summary: { type: "string" },
  },
};

/** The review for a run that never got one: no items, no badge beyond "didn't run". */
export const REVIEW_NOT_RUN: PlanReview = { ran: false, items: [] };

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** True when the string is valid base64, by the same rule the route validator uses. */
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
 * node types.
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

/** Problems with a review input, before any call is spent. [] = usable. */
function inputProblems(input: ReviewInput): string[] {
  const errs: string[] = [];
  if (!isRecord(input)) return ["review: input must be an object"];
  if (!Array.isArray(input.issues)) return ["review: issues must be an array"];
  if (!Array.isArray(input.frames)) return ["review: frames must be an array"];
  input.issues.forEach((issue, i) => {
    if (!isRecord(issue)) {
      errs.push(`review: issues[${i}] must be an object`);
      return;
    }
    if (!Number.isInteger(issue.rank) || (issue.rank as number) < 1) {
      errs.push(`review: issues[${i}].rank must be a whole number >= 1`);
    }
    if (typeof issue.title !== "string" || issue.title.trim().length === 0) {
      errs.push(`review: issues[${i}].title must be a non-empty string`);
    }
    if (typeof issue.detail !== "string" || issue.detail.trim().length === 0) {
      errs.push(`review: issues[${i}].detail must be a non-empty string`);
    }
  });
  // A repeated rank would give the reviewer two problems under one
  // problemId: prompt 06 lists "id <rank>" and asks for one verdict
  // per id, so the second problem would ride in unreviewed while
  // parseReview keeps only the first verdict for that id. The
  // wiring passes a finished plan whose ranks checkWorkPlan already
  // keeps unique, but a direct caller gets the same fail-fast here,
  // before any call is spent. Only valid ranks are compared, so a
  // bad rank keeps its own message instead of also drawing a
  // duplicate one.
  {
    const seenRanks = new Set<number>();
    input.issues.forEach((issue, i) => {
      if (
        isRecord(issue) &&
        Number.isInteger(issue.rank) &&
        (issue.rank as number) >= 1
      ) {
        if (seenRanks.has(issue.rank as number)) {
          errs.push(`review: issues[${i}].rank duplicates an earlier issue`);
        }
        seenRanks.add(issue.rank as number);
      }
    });
  }
  if (input.frames.length > MAX_REVIEW_IMAGES) {
    errs.push(`review: at most ${MAX_REVIEW_IMAGES} frames per request, got ${input.frames.length}`);
  }
  // A repeated frame would ride to the model twice, spending an image
  // slot on a photo already attached and giving two prompt letters to
  // one photo. The wiring dedupes via pickReviewFrames, but a direct
  // caller gets the same fail-fast here, before any call is spent.
  // Only valid indices are compared, so a bad index keeps its own
  // message instead of also drawing a duplicate one.
  {
    const seenFrameIndices = new Set<number>();
    input.frames.forEach((frame, i) => {
      if (
        isRecord(frame) &&
        Number.isInteger(frame.frameIndex) &&
        (frame.frameIndex as number) >= 0
      ) {
        if (seenFrameIndices.has(frame.frameIndex as number)) {
          errs.push(`review: frames[${i}].frameIndex duplicates an earlier frame`);
        }
        seenFrameIndices.add(frame.frameIndex as number);
      }
    });
  }
  input.frames.forEach((frame, i) => {
    if (!isRecord(frame)) {
      errs.push(`review: frames[${i}] must be an object`);
      return;
    }
    if (!Number.isInteger(frame.frameIndex) || (frame.frameIndex as number) < 0) {
      errs.push(`review: frames[${i}].frameIndex must be a whole number >= 0`);
    }
    if (typeof frame.dataUrl !== "string" || !frame.dataUrl.startsWith("data:image/") || !frame.dataUrl.includes(";base64,")) {
      errs.push(`review: frames[${i}].dataUrl must be a data:image base64 URL`);
      return;
    }
    const payload = frame.dataUrl.slice(frame.dataUrl.indexOf(";base64,") + 8);
    if (payload.length === 0 || !isBase64(payload) || !isImageBase64(payload)) {
      errs.push(`review: frames[${i}].dataUrl must carry image data (JPEG, PNG, WebP, or GIF)`);
      return;
    }
    const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
    if (payload.length * 3 / 4 - padding > MAX_REVIEW_IMAGE_BYTES) {
      errs.push(`review: frames[${i}].dataUrl must be at most 5 MB decoded`);
    }
  });
  return errs;
}

function validateReviewDeps(deps: ReviewDeps): void {
  if (!isRecord(deps)) {
    throw new Error("review: deps must be an object");
  }
  if (typeof deps.prompt !== "string" || deps.prompt.trim().length === 0) {
    throw new Error("review: prompt must be a non-empty string");
  }
  if (!isRecord(deps.schema)) {
    throw new Error("review: schema must be an object");
  }
  if (typeof deps.callSpark !== "function") {
    throw new Error("review: callSpark must be a function");
  }
  if (!deps.tracker || typeof deps.tracker.record !== "function") {
    throw new Error("review: tracker.record must be a function");
  }
}

/**
 * Run the reviewer pass. Returns the parsed review on success, or
 * REVIEW_NOT_RUN when the review could not run: a call failure, a
 * model output that fails validation on both attempts, a bad step
 * input, or a usage-tracker throw. Never throws except for bad deps.
 * A model output that parses but answers nothing (no items for
 * non-empty issues) counts as a validation failure and is retried
 * once, like the reason step; a model that answers ran:false is
 * taken at its word with no retry.
 */
export async function runReview(input: ReviewInput, deps: ReviewDeps): Promise<PlanReview> {
  validateReviewDeps(deps);
  // Nothing to check, or nothing to look at: no call is spent, and
  // the no-issue case still reads as a ran review with no verdicts
  // (the plan screen shows no badge for an empty tally either way).
  if (Array.isArray(input?.issues) && input.issues.length === 0) {
    return { ran: true, items: [] };
  }
  const problems = inputProblems(input);
  if (problems.length > 0) {
    console.warn(`runReview: bad input, review not run:\\n${problems.join("\\n")}`);
    return { ...REVIEW_NOT_RUN };
  }
  // Issues but no photos to check them against: there is nothing
  // for the reviewer to look at, so no call is spent. (An empty
  // frames array passes inputProblems above; this is the branch
  // that keeps it from becoming a zero-image model call.)
  if (input.frames.length === 0) {
    console.warn("runReview: no proof photos, review not run");
    return { ...REVIEW_NOT_RUN };
  }
  const images = input.frames.map((f) => f.dataUrl);
  let prompt = deps.prompt;
  for (let attempt = 0; attempt < 2; attempt++) {
    let res: Awaited<ReturnType<ReviewSparkCaller>>;
    try {
      res = await deps.callSpark({ model: SPARK_MODEL, prompt, images, schema: deps.schema, temperature: SPARK_TEMPERATURE, signal: deps.signal });
    } catch (err) {
      // A billed-but-failed call still spent money (e.g. MetaCallError
      // on a non-JSON response): record it before returning, so the
      // route total counts it. A tracker throw here is a failed
      // review, not a spending stop — reviewing is the last step, so
      // there is no later call to protect, and the plan still ships.
      try {
        recordFailedCall(deps.tracker, failedCallModel(err, SPARK_MODEL), "review", err);
      } catch (recErr) {
        console.warn(`runReview: usage record failed, review not run: ${recErr instanceof Error ? recErr.message : String(recErr)}`);
      }
      console.warn(`runReview: call failed, review not run: ${err instanceof Error ? err.message : String(err)}`);
      return { ...REVIEW_NOT_RUN };
    }
    try {
      deps.tracker.record({
        model: res.model ?? SPARK_MODEL,
        step: "review",
        latencyMs: res.latencyMs,
        costUsd: res.costUsd,
      });
    } catch (err) {
      console.warn(`runReview: usage record failed, review not run: ${err instanceof Error ? err.message : String(err)}`);
      return { ...REVIEW_NOT_RUN };
    }
    const parsed = parseReview(res.json, input.issues);
    if (parsed === undefined) {
      if (attempt === 0) {
        prompt = `${deps.prompt}\n\nThe previous output failed validation: it was not a review object with a boolean ran and an items array. Return the full corrected JSON.`;
        continue;
      }
      console.warn("runReview: output failed validation after retry, review not run");
      return { ...REVIEW_NOT_RUN };
    }
    if (!parsed.ran) return { ...REVIEW_NOT_RUN };
    if (parsed.items.length === 0) {
      if (attempt === 0) {
        prompt = `${deps.prompt}\n\nThe previous output failed validation: it answered no problems, but the plan has ${input.issues.length}. Return one verdict per problem in the full corrected JSON.`;
        continue;
      }
      console.warn("runReview: output answered no problems after retry, review not run");
      return { ...REVIEW_NOT_RUN };
    }
    return parsed;
  }
  return { ...REVIEW_NOT_RUN };
}
