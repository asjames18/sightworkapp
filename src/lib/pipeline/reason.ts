/**
 * SightWork pipeline step: `reason`.
 *
 * Takes the sampled frames, the SAM segmentation result, and the
 * narration transcript, and turns them into the ranked-issues / work-plan
 * part of a WorkPlan (prompt 03 spec).
 *
 * This module makes no API calls and holds no keys. The model caller is
 * injected by the wiring code (later: src/lib/meta), so the step is
 * testable on mock data and the spike can swap callers without touching
 * this logic. Every would-be call is recorded on the usage tracker from
 * ./usage.ts, so the $10 spike cap is enforced in code.
 *
 * Prompt and schema are injected too: they come from the prompt 03
 * spec, not from this module. The schema is normalized before it is
 * sent: local `#/$defs/*` references are inlined, because structured
 * output may not accept `$ref`. `anyOf` is passed through as written;
 * if the provider rejects it, the caller surfaces that error verbatim
 * and the step fails loudly instead of guessing.
 *
 * Post-processing (all in the prompt file, enforced here, not trusted
 * to the model):
 * - drop issues with confidence < 0.5; an unmentioned issue needs >= 0.6;
 *   issues from 0.35 up to the bar move to `watch` instead of dropping,
 *   and a null coverageNote is normalized to omitted
 * - re-number ranks 1..n with no gaps, remapping every rank reference
 *   (materials forIssues, workOrder fixes, saidVsSeen issueRank)
 * - drop saidVsSeen rows for dropped issues
 * - drop total/subtotal inventory rows whose count equals the sum of the
 *   same base label's zone rows (prompt 03 rule 7; IMG_9140 double-count guard)
 * - validate with checkWorkPlan from ../types, plus a frameTimeSec check
 *   against the input frames. On failure, retry once with the errors
 *   appended to the prompt. If neither attempt validates cleanly but
 *   at least one parsed and passed the shape check, return the better
 *   result (fewer validation errors, first wins ties) with those
 *   errors on `warnings` instead of failing the run; throw only when
 *   neither attempt gives a schema-valid result (2026-10-27
 *   9:55 AM review). The runner logs the warnings server-side.
 */

import {
  checkWorkPlan,
  type InventoryItem,
  type Issue,
  type MaterialItem,
  type SaidVsSeenEntry,
  type WatchIssue,
  type WorkPlan,
  type WorkStep,
} from "../types";
import { failedCallModel, recordFailedCall, type UsageTracker } from "./usage";

/** SAM segmentation result, per prompt 02. Counts are summed across zones (each zone's best frame), floored at the whole-video single-frame max; with no zones the take is one zone, so the count is the old single-frame max. */
export interface SegmentationResult {
  counts: { label: string; count: number; confidence: number }[];
  /** Sorted, unique frame indices with a hazard-concept instance. */
  flaggedFrames: number[];
}

/** One frame handed to the reason step, in array order. */
export interface ReasonFrame {
  tSec: number;
  /** Browser zone id from PlanRequest.frames (proposal B), printed in the reason frame list when given; omit it and the frame is unzoned. */
  zoneId?: number;
  /** Data URL of the still image, attached to the model call in order. */
  dataUrl: string;
}

export interface ReasonInput {
  frames: ReasonFrame[];
  /**
   * SAM segmentation result, or null when the segment step failed.
   * runPlan logs the failure and continues with null, so the reason
   * step counts from the frames with no SAM floor. runReason never
   * reads this field itself — it rides into the prompt through
   * buildReasonPrompt — so null only changes the prompt text.
   */
  segmentation: SegmentationResult | null;
  /** Transcript string, or null when there is no narration. */
  transcript: string | null;
  spaceName?: string;
  spaceType?: string;
  durationSec: number;
}

/** The part of WorkPlan this step fills. */
export interface ReasonOutput {
  /**
   * Validation errors kept with a returned-but-imperfect result (see
   * runReason). Empty/absent on a clean result. The runner decides
   * whether the full plan can still render with them; they are never
   * sent to the UI as a plan field.
   */
  warnings?: string[];
  spaceName: string;
  generatedFrom: string;
  inventory: InventoryItem[];
  issues: Issue[];
  /**
   * Lower-confidence finds (0.35 up to the ranked bar), kept apart so
   * the ranked list stays clean. filterAndRenumber adds issues the
   * model ranked below the bar here, and passes through any the model
   * already filed in watch. Never priced or reviewed.
   */
  watch?: WatchIssue[];
  /**
   * Why the plan has few problems, when the model found fewer than 3.
   * The model sends null when there are 3+ issues; filterAndRenumber
   * normalizes that null to omitted before any contract check, so the
   * plan type (coverageNote?: string) never sees a null.
   */
  coverageNote?: string | null;
  materials: MaterialItem[];
  workOrder: WorkStep[];
  transcriptSummary: string | null;
  saidVsSeen: SaidVsSeenEntry[];
  heroFrameIndex: number;
}

/** A model call supplied by the wiring code. Never a real call in tests. */
export interface SparkCaller {
  (req: {
    model: string;
    prompt: string;
    images: string[];
    schema: Record<string, unknown>;
    /** Sampling temperature, forwarded verbatim when set. */
    temperature?: number;
    /**
     * Abort signal for a stopped run (2026-11-01): forwarded to the
     * model caller so stopping a run can cut the in-flight reason
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

export interface ReasonDeps {
  /** Prompt text (prompt 03), with placeholders already filled. */
  prompt: string;
  /** Structured-output schema (prompt 03). Normalized before sending. */
  schema: Record<string, unknown>;
  callSpark: SparkCaller;
  tracker: UsageTracker;
  /** Abort signal from runPlan (the route's request signal), forwarded to callSpark. */
  signal?: AbortSignal;
}

const SPARK_MODEL = "muse-spark-1.3";
/** Deterministic structured output for the reason call (2026-10-30 7:52 PM review). */
const SPARK_TEMPERATURE = 0.2;

/** Max decoded bytes per reason frame, same shape as the Spark caller's 5 MB image cap. */
const MAX_REASON_IMAGE_BYTES = 5 * 1024 * 1024;

/** Max frames handed to the reason step, same cap as the route (MAX_PLAN_FRAMES in ./planRequest.ts). */
const MAX_REASON_FRAMES = 48;

/**
 * Inline local `#/$defs/<name>` references and drop `$defs`.
 * Anything else (including `anyOf`) is passed through unchanged.
 * Throws on an unresolvable reference instead of sending a broken schema.
 */
export function inlineSchemaRefs(schema: unknown): unknown {
  // A non-object schema used to pass through silently (null in, null
  // out, so a broken schema rode on toward the model call) and a
  // non-object $defs used to throw a raw TypeError from the `in`
  // check below, with no field named. Reject both here with a named
  // reason error, the same named-error rule the other pipeline entry
  // guards follow. Valid schemas are unchanged: the inlining below
  // still reads exactly the same fields.
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) {
    throw new Error("reason: inlineSchemaRefs schema must be an object");
  }
  const root = schema as Record<string, unknown>;
  if (
    root.$defs !== undefined &&
    (root.$defs === null || typeof root.$defs !== "object" || Array.isArray(root.$defs))
  ) {
    throw new Error("reason: inlineSchemaRefs schema.$defs must be an object");
  }
  const defs = (root.$defs ?? {}) as Record<string, unknown>;

  const resolve = (node: unknown, seen: Set<string>): unknown => {
    if (Array.isArray(node)) return node.map((n) => resolve(n, seen));
    if (node === null || typeof node !== "object") return node;
    const obj = node as Record<string, unknown>;
    if (typeof obj.$ref === "string") {
      const ref = obj.$ref;
      const match = /^#\/\$defs\/([^/]+)$/.exec(ref);
      if (!match || !(match[1] in defs)) {
        throw new Error(`reason: cannot resolve schema $ref "${ref}"`);
      }
      if (seen.has(ref)) throw new Error(`reason: circular schema $ref "${ref}"`);
      const next = new Set(seen);
      next.add(ref);
      const { $ref: _ignored, ...rest } = obj;
      const resolvedDef = resolve(defs[match[1]], next);
      const resolvedRest = resolve(rest, next);
      // resolve() returns unknown, which cannot be spread directly
      // (TS2698); schema defs are objects, anything else inlines to {}.
      return {
        ...(isRecord(resolvedDef) ? resolvedDef : {}),
        ...(isRecord(resolvedRest) ? resolvedRest : {}),
      };
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (k === "$defs") continue;
      out[k] = resolve(v, seen);
    }
    return out;
  };

  return resolve(root, new Set());
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}


/**
 * Prompt 03 rule 7 guard (IMG_9140: a "(total)" row double-counted the
 * zone rows). Drop an inventory row whose label names a total or subtotal
 * when its count equals the sum of the other rows sharing its base label
 * (the label with the trailing parenthetical removed). A total row whose
 * count does not match the zone sum is kept: it may carry real information,
 * and dropping it would lose a count the model actually asserted.
 */
export function dropTotalInventoryRows(inventory: InventoryItem[]): InventoryItem[] {
  // A non-array inventory, a non-object entry, or an entry with a
  // non-string label or non-finite count used to throw a raw TypeError
  // reading .label / .count / .replace off null, with no entry named.
  // Reject all of them here with a named reason error, the same
  // named-error rule the other pipeline entry guards follow. Valid
  // inventories are unchanged: the total-row drop rule below still
  // reads exactly the same fields. (filterAndRenumber calls this, so
  // this guard also covers the inventory side of that entry point,
  // which its own guard deliberately left to this piece.)
  if (!Array.isArray(inventory)) {
    throw new Error("reason: dropTotalInventoryRows inventory must be an array");
  }
  inventory.forEach((item, i) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`reason: dropTotalInventoryRows inventory[${i}] must be an object`);
    }
    if (typeof item.label !== "string") {
      throw new Error(`reason: dropTotalInventoryRows inventory[${i}].label must be a string`);
    }
    if (typeof item.count !== "number" || !Number.isFinite(item.count)) {
      throw new Error(`reason: dropTotalInventoryRows inventory[${i}].count must be a finite number`);
    }
  });
  const baseLabel = (label: string): string => label.replace(/\s*\([^)]*\)\s*$/, "").trim();
  const isTotalRow = (label: string): boolean => /total/i.test(label);
  const sums = new Map<string, number>();
  for (const item of inventory) {
    if (isTotalRow(item.label)) continue;
    const base = baseLabel(item.label);
    sums.set(base, (sums.get(base) ?? 0) + item.count);
  }
  return inventory.filter((item) => {
    if (!isTotalRow(item.label)) return true;
    const sum = sums.get(baseLabel(item.label));
    return sum === undefined || sum !== item.count;
  });
}

/**
 * One-line server-side stability fingerprint for a reason result.
 * Pure, and it changes no plan output: runPlan logs it after the
 * reason step so the next capped run can tell whether a repeat-run
 * swing came from SAM (flagged frames / counts changed) or from the
 * reason model (same SAM input, different issue count). A low issue
 * count is never padded here: finds below the ranked bar already
 * surface as `watch`, so forcing a floor would invent problems.
 */
export function formatReasonStability(
  segmentation: SegmentationResult | null,
  output: Pick<ReasonOutput, "issues" | "watch" | "heroFrameIndex">,
): string {
  // A non-object segmentation, a non-array flaggedFrames/counts, a
  // null counts entry, or a non-object output / non-array issues used
  // to throw a raw TypeError reading .length / .map / .label / .issues
  // off null, with no argument named. A counts entry with a non-string
  // label or a non-whole count was worse: it printed straight into the
  // stability line ("2.5 chairs", "NaN") with no entry named, and
  // that line is what a repeat-run swing is diagnosed from. Reject all
  // of them here with a named reason error, the same named-error rule
  // the other pipeline entry guards follow. A non-whole heroFrameIndex
  // was the same class of bug one field over: it printed straight into
  // the line ("hero frame NaN", "hero frame 2.5") with no error
  // named, so it is rejected here too. Valid inputs are unchanged:
  // the line below still reads exactly the same fields.
  if (
    segmentation !== null &&
    (typeof segmentation !== "object" || Array.isArray(segmentation))
  ) {
    throw new Error("reason: formatReasonStability segmentation must be an object or null");
  }
  if (segmentation !== null) {
    if (!Array.isArray(segmentation.flaggedFrames)) {
      throw new Error("reason: formatReasonStability segmentation.flaggedFrames must be an array");
    }
    if (!Array.isArray(segmentation.counts)) {
      throw new Error("reason: formatReasonStability segmentation.counts must be an array");
    }
    segmentation.counts.forEach((c, i) => {
      if (c === null || typeof c !== "object" || Array.isArray(c)) {
        throw new Error(`reason: formatReasonStability segmentation.counts[${i}] must be an object`);
      }
      if (
        typeof c.label !== "string" ||
        c.label.trim().length === 0 ||
        typeof c.count !== "number" ||
        !Number.isInteger(c.count) ||
        c.count < 0
      ) {
        throw new Error(`reason: formatReasonStability segmentation.counts[${i}] must have a non-empty string label and a whole-number count >= 0`);
      }
    });
  }
  if (output === null || typeof output !== "object" || Array.isArray(output)) {
    throw new Error("reason: formatReasonStability output must be an object");
  }
  if (!Array.isArray(output.issues)) {
    throw new Error("reason: formatReasonStability output.issues must be an array");
  }
  if (output.watch !== undefined && !Array.isArray(output.watch)) {
    throw new Error("reason: formatReasonStability output.watch must be an array");
  }
  if (
    typeof output.heroFrameIndex !== "number" ||
    !Number.isInteger(output.heroFrameIndex) ||
    output.heroFrameIndex < 0
  ) {
    throw new Error(
      "reason: formatReasonStability output.heroFrameIndex must be a whole-number frame index >= 0",
    );
  }
  const sam =
    segmentation === null
      ? "sam skipped"
      : `sam flagged ${segmentation.flaggedFrames.length} frames, counts ${segmentation.counts.map((c) => `${c.label}=${c.count}`).join(", ") || "none"}`;
  return `runPlan: reason stability: ${sam}; reason ${output.issues.length} issues, ${output.watch?.length ?? 0} watch, hero frame ${output.heroFrameIndex}`;
}

/**
 * One-line summary of what the reason step's confidence filter did to
 * the model's raw output. Pure, and it changes no plan output:
 * runReason logs it only when the filter actually removed or demoted
 * an issue, so a clean pass stays quiet. The stability line reports
 * the post-filter counts, which cannot tell "the model returned 1
 * issue" from "the model returned 5 and the filter dropped 4" — this
 * line closes that gap for repeat-run diagnosis. `demoted` is the
 * growth in watch entries over the model's own watch list (the filter
 * appends demoted issues to it); `dropped` is what is left of the raw
 * issues after the kept ranks and the demoted ones.
 */
export function formatReasonFilter(
  raw: Pick<ReasonOutput, "issues" | "watch">,
  filtered: Pick<ReasonOutput, "issues" | "watch">,
): string {
  // A non-object side or a non-array issues list used to throw a raw
  // TypeError reading .issues off null — or worse, silently produce a
  // nonsense line (a string issues list counts its characters and
  // reports a negative drop count). Reject both sides here with a
  // named reason error, the same named-error rule the other pipeline
  // entry guards follow. Valid inputs are unchanged.
  const checkSide = (name: string, value: Pick<ReasonOutput, "issues" | "watch">): void => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`reason: formatReasonFilter ${name} must be an object`);
    }
    if (!Array.isArray(value.issues)) {
      throw new Error(`reason: formatReasonFilter ${name}.issues must be an array`);
    }
    if (value.watch !== undefined && !Array.isArray(value.watch)) {
      throw new Error(`reason: formatReasonFilter ${name}.watch must be an array`);
    }
  };
  checkSide("raw", raw);
  checkSide("filtered", filtered);
  const rawIssues = raw.issues.length;
  const rawWatch = raw.watch?.length ?? 0;
  const kept = filtered.issues.length;
  const totalWatch = filtered.watch?.length ?? 0;
  const demoted = Math.max(0, totalWatch - rawWatch);
  const dropped = rawIssues - kept - demoted;
  return `reason: filter kept ${kept} ranked, ${totalWatch} watch (${rawWatch} from model, ${demoted} demoted), dropped ${dropped} of ${rawIssues} raw issues`;
}

/** Log the filter line only when the filter removed or demoted an issue. */
function logReasonFilterIfLossy(raw: ReasonOutput, filtered: ReasonOutput): void {
  const rawWatch = raw.watch?.length ?? 0;
  const totalWatch = filtered.watch?.length ?? 0;
  if (filtered.issues.length < raw.issues.length || totalWatch > rawWatch) {
    console.log(formatReasonFilter(raw, filtered));
  }
}

/** Confidence filter + rank renumber, with rank references remapped.
 * Issues at or above the bar (0.5, or 0.6 when unmentioned) stay
 * ranked. Issues from 0.35 up to the bar move to `watch` instead of
 * being dropped silently: a watch entry keeps the title, detail,
 * confidence, primary frame, area, evidence, checklistKey and proof
 * frames, but no rank, so nothing prices or reviews it. Anything
 * below 0.35 is dropped. A null coverageNote is normalized to
 * omitted (types.ts declares coverageNote?: string, and the client
 * already treats null as absent). Rank references in materials,
 * workOrder and saidVsSeen are remapped to kept ranks only, so a
 * reference to a demoted or dropped issue disappears rather than
 * pointing at the wrong problem. */
export function filterAndRenumber(output: ReasonOutput): ReasonOutput {
  // A non-object output, a non-array collection (including the
  // passed-through watch list), or a non-object entry in one of
  // the collections below used to throw a raw
  // TypeError reading .watch / .confidence / .forIssues / .fixes /
  // .issueRank off null, with no entry named. Reject all of them here
  // with a named reason error, the same named-error rule the other
  // pipeline entry guards follow. Valid outputs are unchanged: every
  // collection is still read exactly as before. (Inventory entries
  // are read by dropTotalInventoryRows, not here, so its own guard
  // is a separate piece.)
  if (output === null || typeof output !== "object" || Array.isArray(output)) {
    throw new Error("reason: filterAndRenumber output must be an object");
  }
  const entries = (field: string, value: unknown): void => {
    if (!Array.isArray(value)) {
      throw new Error(`reason: filterAndRenumber output.${field} must be an array`);
    }
    value.forEach((entry, i) => {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
        throw new Error(`reason: filterAndRenumber output.${field}[${i}] must be an object`);
      }
    });
  };
  entries("issues", output.issues);
  entries("materials", output.materials);
  entries("workOrder", output.workOrder);
  entries("saidVsSeen", output.saidVsSeen);
  // Watch is passed through untouched below, so it was the one
  // collection this guard skipped: a string watch spread into single
  // characters, and a null watch entry passed through silently, both
  // with no entry named. Guard it the same way.
  if (output.watch !== undefined) {
    if (!Array.isArray(output.watch)) {
      throw new Error("reason: filterAndRenumber output.watch must be an array");
    }
    output.watch.forEach((entry, i) => {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
        throw new Error(`reason: filterAndRenumber output.watch[${i}] must be an object`);
      }
    });
  }
  // Rank references are remapped below with .filter/.map, so a
  // non-array forIssues/fixes used to throw a raw TypeError reading
  // .filter off a string, and a non-number rank inside one was
  // silently dropped by the remap lookup, with no entry named.
  // Guard both the same way. Valid outputs are unchanged: the
  // remap below still reads exactly the same fields.
  output.materials.forEach((m, i) => {
    const refs = (m as { forIssues?: unknown }).forIssues;
    if (refs === undefined) return;
    if (!Array.isArray(refs)) {
      throw new Error(`reason: filterAndRenumber output.materials[${i}].forIssues must be an array`);
    }
    refs.forEach((r, j) => {
      if (typeof r !== "number" || !Number.isFinite(r)) {
        throw new Error(`reason: filterAndRenumber output.materials[${i}].forIssues[${j}] must be a finite number`);
      }
    });
  });
  output.workOrder.forEach((s, i) => {
    const refs = (s as { fixes?: unknown }).fixes;
    if (refs === undefined) return;
    if (!Array.isArray(refs)) {
      throw new Error(`reason: filterAndRenumber output.workOrder[${i}].fixes must be an array`);
    }
    refs.forEach((r, j) => {
      if (typeof r !== "number" || !Number.isFinite(r)) {
        throw new Error(`reason: filterAndRenumber output.workOrder[${i}].fixes[${j}] must be a finite number`);
      }
    });
  });
  // saidVsSeen rows are filtered below by the remap lookup, so a
  // non-number issueRank used to be silently dropped as an
  // unkept rank, with no entry named. Guard it the same way:
  // an undefined rank stays (a row with no matching issue),
  // anything else must be a finite number.
  output.saidVsSeen.forEach((row, i) => {
    const rank = (row as { issueRank?: unknown }).issueRank;
    if (rank === undefined) return;
    if (typeof rank !== "number" || !Number.isFinite(rank)) {
      throw new Error(`reason: filterAndRenumber output.saidVsSeen[${i}].issueRank must be a finite number`);
    }
  });
  // Issues are kept, watched, or dropped below by confidence, so a
  // non-number confidence used to be silently mishandled: NaN
  // falls through every bar and drops the issue with no entry
  // named, null fell to 0 through ?? and dropped the same way,
  // and a string coerced through the comparison. Guard it the
  // same way: an undefined confidence stays (it still defaults
  // to 0 below, the old drop), anything else must be a finite
  // number.
  output.issues.forEach((issue, i) => {
    const confidence = (issue as { confidence?: unknown }).confidence;
    if (confidence === undefined) return;
    if (typeof confidence !== "number" || !Number.isFinite(confidence)) {
      throw new Error(`reason: filterAndRenumber output.issues[${i}].confidence must be a finite number`);
    }
  });
  // The keep bar below reads `unmentioned` only for truthiness, so a
  // non-boolean value used to silently pick the wrong bar: the string
  // "false" is truthy and raised the bar to 0.6, dropping an issue
  // that should have stayed ranked, with no entry named. Guard it
  // the same way: an undefined unmentioned stays (it still takes
  // the 0.5 bar below), anything else must be a boolean.
  output.issues.forEach((issue, i) => {
    const unmentioned = (issue as { unmentioned?: unknown }).unmentioned;
    if (unmentioned === undefined) return;
    if (typeof unmentioned !== "boolean") {
      throw new Error(`reason: filterAndRenumber output.issues[${i}].unmentioned must be a boolean`);
    }
  });
  // Issues are renumbered below through a remap keyed on rank, so a
  // non-number rank used to silently break every rank reference to
  // that issue: a string key never matches a numeric forIssues/fixes
  // entry, so the reference was dropped by the remap lookup with no
  // entry named, while the kept issue itself was renumbered anyway.
  // Guard it the same way: rank is required, so anything but a
  // finite number throws a named error.
  output.issues.forEach((issue, i) => {
    const rank = (issue as { rank?: unknown }).rank;
    if (typeof rank !== "number" || !Number.isFinite(rank)) {
      throw new Error(`reason: filterAndRenumber output.issues[${i}].rank must be a finite number`);
    }
  });
  const kept: Issue[] = [];
  const watch: WatchIssue[] = [...(output.watch ?? [])];
  const remap = new Map<number, number>();
  for (const issue of output.issues) {
    const confidence = issue.confidence ?? 0;
    const floor = issue.unmentioned ? 0.6 : 0.5;
    if (confidence >= floor) {
      remap.set(issue.rank, kept.length + 1);
      kept.push({ ...issue, rank: kept.length + 1 });
    } else if (confidence >= 0.35) {
      const entry: WatchIssue = {
        title: issue.title,
        detail: issue.detail,
        frameIndex: issue.frameIndex,
        frameTimeSec: issue.frameTimeSec,
      };
      if (issue.confidence !== undefined) entry.confidence = issue.confidence;
      if (issue.area !== undefined) entry.area = issue.area;
      if (issue.evidence !== undefined) entry.evidence = issue.evidence;
      if (issue.checklistKey !== undefined) entry.checklistKey = issue.checklistKey;
      if (issue.proofFrames !== undefined) entry.proofFrames = issue.proofFrames;
      watch.push(entry);
    }
  }
  const remapList = (ranks: number[] | undefined): number[] | undefined =>
    ranks === undefined
      ? undefined
      : ranks.filter((r) => remap.has(r)).map((r) => remap.get(r) as number);
  return {
    ...output,
    inventory: dropTotalInventoryRows(output.inventory),
    issues: kept,
    watch: watch.length > 0 ? watch : undefined,
    coverageNote: output.coverageNote ?? undefined,
    materials: output.materials.map((m) => ({ ...m, forIssues: remapList(m.forIssues) })),
    workOrder: output.workOrder.map((s) => ({ ...s, fixes: remapList(s.fixes) })),
    saidVsSeen: output.saidVsSeen
      .filter((row) => row.issueRank === undefined || remap.has(row.issueRank))
      .map((row) => ({
        ...row,
        issueRank: row.issueRank === undefined ? undefined : remap.get(row.issueRank),
      })),
  };
}

/** Validate a reason result against the input frames and the contract. */
export function validateReason(input: ReasonInput, output: ReasonOutput): string[] {
  // A non-object input/output, a non-array input.frames or
  // output.issues/watch, a non-object issue/watch entry, or a
  // non-array proofFrames list used to throw a raw TypeError reading
  // .forEach / .frameIndex / .tSec off null, with no argument named.
  // Reject all of them here with a named reason error, the same
  // named-error rule the other pipeline entry guards follow. Valid
  // inputs are unchanged: every collection is still read exactly as
  // before, and frame mismatches still return error strings rather
  // than throwing.
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("reason: validateReason input must be an object");
  }
  if (!Array.isArray(input.frames)) {
    throw new Error("reason: validateReason input.frames must be an array");
  }
  if (output === null || typeof output !== "object" || Array.isArray(output)) {
    throw new Error("reason: validateReason output must be an object");
  }
  if (!Array.isArray(output.issues)) {
    throw new Error("reason: validateReason output.issues must be an array");
  }
  if (output.watch !== undefined && !Array.isArray(output.watch)) {
    throw new Error("reason: validateReason output.watch must be an array");
  }
  const checkEntries = (field: string, value: unknown[]): void => {
    value.forEach((entry, i) => {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
        throw new Error(`reason: validateReason output.${field}[${i}] must be an object`);
      }
      const proof = (entry as { proofFrames?: unknown }).proofFrames;
      if (proof !== undefined && !Array.isArray(proof)) {
        throw new Error(`reason: validateReason output.${field}[${i}].proofFrames must be an array`);
      }
      if (Array.isArray(proof)) {
        proof.forEach((f, j) => {
          if (f === null || typeof f !== "object" || Array.isArray(f)) {
            throw new Error(`reason: validateReason output.${field}[${i}].proofFrames[${j}] must be an object`);
          }
        });
      }
    });
  };
  checkEntries("issues", output.issues);
  if (output.watch !== undefined) checkEntries("watch", output.watch);
  const errs: string[] = [];
  output.issues.forEach((issue, i) => {
    const frame = input.frames[issue.frameIndex];
    if (!frame) {
      errs.push(`issues[${i}].frameIndex ${issue.frameIndex} out of range`);
    } else if (issue.frameTimeSec !== frame.tSec) {
      errs.push(
        `issues[${i}].frameTimeSec ${issue.frameTimeSec} does not match frames[${issue.frameIndex}].tSec ${frame.tSec}`,
      );
    }
    issue.proofFrames?.forEach((f, j) => {
      const pf = input.frames[f.frameIndex];
      if (!pf) errs.push(`issues[${i}].proofFrames[${j}].frameIndex out of range`);
      else if (f.tSec !== pf.tSec)
        errs.push(`issues[${i}].proofFrames[${j}].tSec does not match frames[${f.frameIndex}].tSec`);
    });
  });
  // Watch finds follow the same frame rules as issues (types.ts):
  // the primary frame must exist and its time must match.
  output.watch?.forEach((w, i) => {
    const frame = input.frames[w.frameIndex];
    if (!frame) {
      errs.push(`watch[${i}].frameIndex ${w.frameIndex} out of range`);
    } else if (w.frameTimeSec !== frame.tSec) {
      errs.push(
        `watch[${i}].frameTimeSec ${w.frameTimeSec} does not match frames[${w.frameIndex}].tSec ${frame.tSec}`,
      );
    }
    w.proofFrames?.forEach((f, j) => {
      const pf = input.frames[f.frameIndex];
      if (!pf) errs.push(`watch[${i}].proofFrames[${j}].frameIndex out of range`);
      else if (f.tSec !== pf.tSec)
        errs.push(`watch[${i}].proofFrames[${j}].tSec does not match frames[${f.frameIndex}].tSec`);
    });
  });
  if (output.heroFrameIndex < 0 || output.heroFrameIndex >= input.frames.length) {
    errs.push(`heroFrameIndex ${output.heroFrameIndex} out of range`);
  }
  // Contract check on the assembled shell (frames omitted: the full
  // pipeline re-runs checkWorkPlan once frames are attached).
  const shell: WorkPlan = {
    spaceName: output.spaceName,
    generatedFrom: output.generatedFrom,
    inventory: output.inventory,
    issues: output.issues,
    watch: output.watch,
    coverageNote: output.coverageNote ?? undefined,
    materials: output.materials,
    workOrder: output.workOrder,
    afterImageUrl: null,
    transcript: input.transcript,
    transcriptSummary: output.transcriptSummary,
    saidVsSeen: output.saidVsSeen,
    heroFrameIndex: output.heroFrameIndex,
  };
  return [...errs, ...checkWorkPlan(shell)];
}

function shapeProblems(json: unknown): string[] {
  if (!isRecord(json)) return ["reason: model output is not a JSON object"];
  const errs: string[] = [];
  for (const key of ["spaceName", "generatedFrom", "inventory", "issues", "materials", "workOrder", "transcriptSummary", "saidVsSeen", "heroFrameIndex"]) {
    if (!(key in json)) errs.push(`reason: model output is missing "${key}"`);
  }
  if (!Array.isArray(json.issues)) errs.push('reason: "issues" is not an array');
  return errs;
}

/**
 * Fail fast on a bad reason request, before any paid Spark call.
 * A bad request used to spend up to two Spark calls (initial attempt
 * plus retry) and only fail downstream, when the step parsed an empty
 * or garbage result. Shape-only checks for segmentation: runReason
 * never reads it directly (it rides into the prompt through
 * buildReasonPrompt), so flaggedFrames are checked as integers >= 0
 * but not range-checked against frames here, and counts are checked
 * as whole numbers, since a fractional count is not a count.
 */
/**
 * True when the string is valid base64, by the same rule the route
 * validator uses (src/lib/pipeline/planRequest.ts): base64 alphabet
 * plus up to two padding chars, length a multiple of 4, whitespace
 * ignored. Used only by validateReasonRequest below.
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

export function validateReasonRequest(input: ReasonInput, deps: ReasonDeps): void {
  if (!input || typeof input !== "object") {
    throw new Error("reason: input must be an object");
  }
  if (!Array.isArray(input.frames) || input.frames.length === 0) {
    throw new Error("reason: frames must be a non-empty array");
  }
  // Parity with the route validator (src/lib/pipeline/planRequest.ts)
  // and validateRunPlanRequest (src/lib/pipeline/runPlan.ts): the
  // browser builder sends at most 48 frames (prompt 02, under the
  // 50-images-per-request limit), and the meta path hands the reason
  // step every request frame, so a direct runReason caller with 49+
  // frames used to pass here and ride onto a paid Spark call with
  // more images than any real run ever sends. Reject it here, before
  // any fetch, like the route and runPlan do. Real runs are already
  // capped, so no current run changes.
  if (input.frames.length > MAX_REASON_FRAMES) {
    throw new Error(`reason: frames must not exceed ${MAX_REASON_FRAMES}`);
  }
  input.frames.forEach((f, i) => {
    if (
      !f ||
      typeof f !== "object" ||
      typeof f.tSec !== "number" ||
      !Number.isFinite(f.tSec) ||
      f.tSec < 0 ||
      typeof f.dataUrl !== "string" ||
      f.dataUrl.trim().length === 0
    ) {
      throw new Error(`reason: frame ${i} has no valid tSec/dataUrl`);
    }
    // Parity with the route validator (src/lib/pipeline/planRequest.ts)
    // and validateRunPlanRequest: a frame dataUrl must be a
    // data:image base64 URL carrying a real image header. A bare
    // string (or a text blob re-labelled data:image/jpeg) used to
    // pass here and only surface later, when the paid reason call
    // was spent on garbage input. A direct runReason caller gets the
    // same fail-fast here instead of only via the route.
    if (
      !f.dataUrl.startsWith("data:image/") ||
      !f.dataUrl.includes(";base64,")
    ) {
      throw new Error(
        `reason: frame ${i} dataUrl must be a data:image base64 URL`,
      );
    }
    {
      const payload = f.dataUrl.slice(f.dataUrl.indexOf(";base64,") + 8);
      if (payload.length === 0 || !isBase64(payload)) {
        throw new Error(
          `reason: frame ${i} dataUrl must carry valid base64 image data`,
        );
      }
      if (!isImageBase64(payload)) {
        throw new Error(
          `reason: frame ${i} dataUrl must carry image data (JPEG, PNG, WebP, or GIF)`,
        );
      }
      // Same shape as the Spark caller's 5 MB image cap: the reason
      // frames are 1024 px JPEGs, but a direct runReason caller
      // bypassing runPlan had no bound here, so an unbounded frame
      // would ride onto a paid Spark call before any cap could stop
      // it. 5 MB decoded is wide headroom over a 1024 px JPEG frame;
      // reject it here, before any fetch.
      const stripped = payload.replace(/\s/g, "");
      const padding = stripped.endsWith("==") ? 2 : stripped.endsWith("=") ? 1 : 0;
      const decodedBytes = (stripped.length * 3) / 4 - padding;
      if (decodedBytes > MAX_REASON_IMAGE_BYTES) {
        throw new Error(
          `reason: frame ${i} dataUrl must be at most 5 MB, got ${decodedBytes} bytes`,
        );
      }
    }
  });
  // Parity with the route validator (src/lib/pipeline/planRequest.ts):
  // the reason frame list rides into the prompt in array order, so
  // an out-of-order frame would mislabel what was seen when against
  // the transcript's said-vs-saw alignment, and a direct runReason
  // caller bypassing the route had no order check here. Frames must
  // be non-decreasing in tSec, like the route's frames and the
  // transcript turns; equal tSec passes, and prevTsec advances on
  // every valid tSec, so a malformed frame keeps its own message
  // from the loop above instead of also drawing an order one.
  // Real runs are already ordered (runPlan hands the reason step the
  // route-validated frames in order), so no current run changes.
  {
    let prevTsec = -Infinity;
    input.frames.forEach((f, i) => {
      if (
        f &&
        typeof f === "object" &&
        typeof f.tSec === "number" &&
        Number.isFinite(f.tSec) &&
        f.tSec >= 0
      ) {
        if (f.tSec < prevTsec) {
          throw new Error(
            `reason: frame ${i} tSec must not be earlier than the previous frame`,
          );
        }
        prevTsec = f.tSec;
      }
    });
  }
  // Parity with buildReasonPrompt (src/lib/pipeline/planPrompts.ts)
  // and the route validator (src/lib/pipeline/planRequest.ts): a
  // frame's zoneId is optional, but when given it must be a whole
  // number >= 0, and it prints verbatim in the prompt's frame list
  // (zone=${f.zoneId}). A direct runReason caller with a prebuilt
  // prompt bypasses the prompt build, so a bad zone used to ride
  // into a paid Spark call mislabelled (zone=-1, zone=1.5) instead
  // of failing fast here. Only frames that are objects are checked,
  // so a malformed frame keeps its own message from the loop above.
  // Real runs are already valid (the route validates zoneId before
  // runPlan hands frames over), so no current run changes.
  input.frames.forEach((f, i) => {
    if (
      f &&
      typeof f === "object" &&
      f.zoneId !== undefined &&
      (!Number.isInteger(f.zoneId) || f.zoneId < 0)
    ) {
      throw new Error(
        `reason: frame ${i} zoneId must be a whole number >= 0 when given`,
      );
    }
  });
  if (input.segmentation !== null) {
    const seg = input.segmentation;
    if (!seg || typeof seg !== "object") {
      throw new Error("reason: segmentation must be an object or null");
    }
    // Parity with buildReasonPrompt (src/lib/pipeline/planPrompts.ts):
    // the prompt build rejects a segmentation value that is an array
    // at all, because arrays are objects in JavaScript and the object
    // check above lets them through — so an array segmentation used
    // to draw the generic "counts must be an array" message here
    // (an array has no counts property), hiding that the whole
    // segmentation value was the wrong shape. A direct runReason
    // caller with a prebuilt prompt bypasses the prompt build and
    // had no such named check here, so it gets the same fail-fast
    // before any paid Spark call. This sits before the counts check
    // below, so an array segmentation names itself instead of
    // drawing the counts message, and a non-object segmentation
    // keeps its own message from the check above. Real runs are
    // already clean (the segment step emits a plain object), so no
    // current run changes.
    if (Array.isArray(seg)) {
      throw new Error("reason: segmentation must be an object, not an array");
    }
    if (!Array.isArray(seg.counts)) {
      throw new Error("reason: segmentation.counts must be an array");
    }
    // Parity with buildReasonPrompt (src/lib/pipeline/planPrompts.ts):
    // the prompt build rejects a counts entry that is an array at
    // all, because arrays are objects in JavaScript and the per-field
    // guards read label, count and confidence straight off the array
    // — so an entry carrying those fields as array properties passed
    // every check here, yet JSON.stringify drops array properties and
    // it would print as an empty "[]" with its count silently lost.
    // A direct runReason caller with a prebuilt prompt bypasses the
    // prompt build and had no such check here, so it gets the same
    // fail-fast before any paid Spark call. This sits before the
    // counts validation below, so an array entry names itself instead
    // of drawing the generic label/count/confidence message. Real
    // runs are already clean (the segment step emits plain objects),
    // so no current run changes.
    seg.counts.forEach((c, i) => {
      if (Array.isArray(c)) {
        throw new Error(
          `reason: segmentation.counts[${i}] must be an object, not an array`,
        );
      }
    });
    seg.counts.forEach((c, i) => {
      // Counts are whole instances (the segment step takes a max over
      // frames): a fractional count used to pass this check and ride
      // into the reason prompt as nonsense like "2.5 chairs".
      if (
        !c ||
        typeof c !== "object" ||
        typeof c.label !== "string" ||
        c.label.trim().length === 0 ||
        typeof c.count !== "number" ||
        !Number.isInteger(c.count) ||
        c.count < 0 ||
        typeof c.confidence !== "number" ||
        !Number.isFinite(c.confidence) ||
        c.confidence < 0 ||
        c.confidence > 1
      ) {
        throw new Error(`reason: segmentation.counts[${i}] has no valid label/count/confidence`);
      }
    });
    // Parity with buildReasonPrompt (src/lib/pipeline/planPrompts.ts):
    // the prompt build rejects a {{...}} placeholder in a counts
    // label, since the prompt template fills {{...}} slots itself
    // and a label carrying one would print as an unfilled slot in
    // the finished prompt. A direct runReason caller with a prebuilt
    // prompt bypasses the prompt build and had no such check here,
    // so a placeholder label would ride onto a paid Spark call.
    // This sits after the counts validation above, so a malformed
    // entry keeps its own message. Real runs are already clean (the
    // segment step emits plain labels), so no current run changes.
    seg.counts.forEach((c, i) => {
      if (/\{\{[a-z_]+\}\}/.test(c.label)) {
        throw new Error(
          `reason: segmentation.counts[${i}].label must not contain a {{...}} placeholder`,
        );
      }
    });
    // Parity with buildReasonPrompt (src/lib/pipeline/planPrompts.ts):
    // the prompt build rejects a repeated counts label (exact, case, or
    // surrounding whitespace) instead of printing it twice, where the
    // model could add the two rows together and overstate the
    // inventory. A direct runReason caller with a prebuilt prompt
    // bypasses the prompt build and had no such check here, so a
    // duplicate label would ride onto a paid Spark call. Labels are
    // compared trimmed and lowercased, like the prompt build. This
    // sits after the counts validation above, so a malformed entry
    // keeps its own message. Real runs are already unique (the
    // segment step emits one row per label), so no current run
    // changes.
    {
      const seen = new Set<string>();
      seg.counts.forEach((c, i) => {
        const key = c.label.trim().toLowerCase();
        if (seen.has(key)) {
          throw new Error(
            `reason: segmentation.counts[${i}].label must be unique`,
          );
        }
        seen.add(key);
      });
    }
    if (
      !Array.isArray(seg.flaggedFrames) ||
      seg.flaggedFrames.some((f) => !Number.isInteger(f) || f < 0)
    ) {
      throw new Error("reason: segmentation.flaggedFrames must be an array of integers >= 0");
    }
    // A flagged frame is an index into input.frames (the segment step
    // returns sorted, unique indices of frames with a hazard-concept
    // instance), so an index at or past frames.length names a frame
    // that does not exist, and a direct runReason caller bypassing
    // the segment step had no range check here — the prompt would
    // then claim SAM flagged a frame outside the video. Only valid
    // integer indices are checked, so a malformed entry keeps its
    // message from the check above. Real runs are already in range
    // (the segment step flags only frames it was given), so no
    // current run changes.
    seg.flaggedFrames.forEach((f, i) => {
      if (Number.isInteger(f) && f >= 0 && f >= input.frames.length) {
        throw new Error(
          `reason: segmentation.flaggedFrames[${i}] must refer to an existing frame`,
        );
      }
    });
    // The segment step returns flaggedFrames sorted and unique (see
    // src/lib/pipeline/segment.ts), so a duplicate would double-count
    // a flagged frame in the reason prompt and an out-of-order list
    // would misstate which frames SAM flagged first. A direct
    // runReason caller bypassing the segment step had no order check
    // here, so flaggedFrames must be strictly increasing. Only valid
    // integer indices are checked, so a malformed or out-of-range
    // entry keeps its own message from the checks above. Real runs
    // are already sorted and unique, so no current run changes.
    seg.flaggedFrames.forEach((f, i) => {
      const prev = seg.flaggedFrames[i - 1];
      if (
        i > 0 &&
        Number.isInteger(f) &&
        f >= 0 &&
        Number.isInteger(prev) &&
        prev >= 0 &&
        f <= prev
      ) {
        throw new Error(
          `reason: segmentation.flaggedFrames[${i}] must be greater than the previous flagged frame`,
        );
      }
    });
    // Parity with buildReasonPrompt (src/lib/pipeline/planPrompts.ts):
    // the whole segmentation object is printed verbatim as JSON in
    // the prompt, so a {{...}} token in any part the per-field guards
    // above do not cover (an extra field on a counts entry, or an
    // extra top-level field) would be expanded by the later
    // transcript fill instead of failing — an entry zone of "stage
    // {{transcript}}" used to print the whole transcript inside the
    // SEGMENTATION section. A direct runReason caller with a prebuilt
    // prompt bypasses the prompt build and had no such check here,
    // so it gets the same fail-fast before any paid Spark call.
    // This sits after every per-field check above, so a label token
    // keeps its label message and a malformed flagged frame keeps
    // its own message. Real runs are already clean (the segment
    // step emits only label/count/confidence rows and flagged
    // frames), so no current run changes.
    if (/\{\{[a-z_]+\}\}/.test(JSON.stringify(seg))) {
      throw new Error("reason: segmentation must not contain a {{...}} placeholder");
    }
  }
  if (input.transcript !== null && typeof input.transcript !== "string") {
    throw new Error("reason: transcript must be a string or null");
  }
  // Parity with buildReasonPrompt (src/lib/pipeline/planPrompts.ts)
  // and the route/runPlan validators: null means no narration, but
  // a blank string is neither a transcript nor null, so a direct
  // runReason caller gets the same fail-fast here instead of only
  // via the prompt build — or, with a prebuilt prompt, carrying a
  // blank transcript into the finished plan. Real transcripts from
  // /api/transcribe are never blank, so no current run changes.
  if (
    typeof input.transcript === "string" &&
    input.transcript.trim().length === 0
  ) {
    throw new Error("reason: transcript must not be blank");
  }
  for (const field of ["spaceName", "spaceType"] as const) {
    const v = input[field];
    if (v !== undefined && (typeof v !== "string" || v.trim().length === 0)) {
      throw new Error(`reason: ${field} must be a non-empty string when given`);
    }
    // Parity with buildReasonPrompt (src/lib/pipeline/planPrompts.ts):
    // the prompt build interpolates these names into the prompt text,
    // so it rejects a newline, a {{...}} placeholder, and (for
    // spaceName only) a double quote. A direct runReason caller with a
    // prebuilt prompt bypasses the prompt build and had no such check
    // here, so a bad name would ride onto a paid Spark call and come
    // back printed in the finished plan. Only given strings are
    // checked, so an omitted name keeps its message from the check
    // above, and a blank one keeps that message too. Real runs are
    // already valid (the prompt build rejects these before runReason
    // is ever reached), so no current run changes.
    if (typeof v === "string" && /[\r\n]/.test(v)) {
      throw new Error(`reason: ${field} must not contain a newline`);
    }
    if (typeof v === "string" && /\{\{[a-z_]+\}\}/.test(v)) {
      throw new Error(`reason: ${field} must not contain a {{...}} placeholder`);
    }
  }
  if (typeof input.spaceName === "string" && input.spaceName.includes('"')) {
    throw new Error('reason: spaceName must not contain a double quote');
  }
  if (typeof input.durationSec !== "number" || !Number.isFinite(input.durationSec) || input.durationSec < 0) {
    throw new Error(`reason: durationSec must be a finite number >= 0, got ${input.durationSec}`);
  }
  // Parity with the route validator (src/lib/pipeline/planRequest.ts)
  // and validateRunPlanRequest: a frame timestamp past durationSec
  // would mislabel a proof frame as coming from inside a video that
  // had already ended, and a direct runReason caller bypassing the
  // route had no such check here. Frames must not exceed durationSec;
  // a frame exactly at durationSec passes, like the route's frames.
  // This sits after the durationSec check above, so an invalid
  // duration keeps its own message, and only valid tSec frames are
  // checked, so a malformed frame keeps its own message from the
  // loop above. Real runs are already in range (runPlan hands the
  // reason step the route-validated frames), so no current run changes.
  input.frames.forEach((f, i) => {
    if (
      f &&
      typeof f === "object" &&
      typeof f.tSec === "number" &&
      Number.isFinite(f.tSec) &&
      f.tSec >= 0 &&
      f.tSec > input.durationSec
    ) {
      throw new Error(
        `reason: frame ${i} tSec must not exceed durationSec`,
      );
    }
  });
  if (!deps || typeof deps !== "object") {
    throw new Error("reason: deps must be an object");
  }
  if (typeof deps.prompt !== "string" || deps.prompt.trim().length === 0) {
    throw new Error("reason: prompt must be a non-empty string");
  }
  // Parity with buildReasonPrompt (src/lib/pipeline/planPrompts.ts):
  // a finished prompt never carries an unfilled {{...}} placeholder
  // (the builder throws on one after the last fill), and the
  // ReasonDeps doc says the prompt arrives with placeholders already
  // filled. A direct runReason caller passing the raw template, or a
  // partially filled prompt, used to pass here and ride onto a paid
  // Spark call with literal {{space_name}} / {{transcript}} slots in
  // it instead of the space, frames, segmentation and narration. It
  // gets the same fail-fast here, before any fetch. This sits after
  // the non-empty check above, so a blank prompt keeps its own
  // message. Real runs are already clean (the route hands runReason
  // the finished prompt from buildReasonPrompt), so no current run
  // changes.
  if (/\{\{[a-z_]+\}\}/.test(deps.prompt)) {
    throw new Error("reason: prompt must not contain an unfilled {{...}} placeholder");
  }
  if (!isRecord(deps.schema)) {
    throw new Error("reason: schema must be an object");
  }
  // Parity with runReason's own normalization below (inlineSchemaRefs
  // on deps.schema, before any callSpark): a schema whose $ref cannot
  // be resolved, whose $defs is not an object, or whose $ref is
  // circular used to pass this validator and only fail at that
  // normalization step, so a direct validateReasonRequest caller
  // learned the request was bad only by running it. The dry-run
  // inlining here (result discarded; inlineSchemaRefs is pure and
  // builds new objects) throws the same named error up front, before
  // any paid Spark call. Valid schemas are unchanged ({} and any
  // resolvable $ref pass), and runReason still normalizes again for
  // the call itself, so no current run changes.
  inlineSchemaRefs(deps.schema);
  if (typeof deps.callSpark !== "function") {
    throw new Error("reason: callSpark must be a function");
  }
  if (!deps.tracker || typeof deps.tracker.record !== "function") {
    throw new Error("reason: tracker.record must be a function");
  }
  // Parity with the Meta client (src/lib/meta/client.ts), which passes
  // the signal straight to fetch: a direct runReason caller handing
  // over a non-signal (a string, a number, a plain object) used to
  // pass here and ride onto a paid Spark call that fetch would then
  // reject with a bare TypeError — or, for a plain object, never
  // abort at all, since signal.aborted reads undefined and the stop
  // never reaches the in-flight call. A signal, when given, must
  // look like an AbortSignal (a boolean aborted plus
  // addEventListener and removeEventListener: every real AbortSignal
  // carries both, and a two-method fake with only aborted and
  // addEventListener used to pass here and still die in fetch with
  // that bare TypeError), so a bad one fails fast here, before any
  // fetch. Omitted stays omitted, and a real AbortController signal
  // passes unchanged. Real runs are already clean (runPlan hands
  // over the route's request signal), so no current run changes.
  // Duck-typing stops here on purpose: a fake implementing all three
  // methods still is not a real AbortSignal, but an instanceof check
  // would break a signal from another realm, so that last mile stays
  // fetch's own error rather than a new rule.
  const signal = deps.signal as unknown;
  if (
    signal !== undefined &&
    (signal === null ||
      typeof signal !== "object" ||
      typeof (signal as { aborted?: unknown }).aborted !== "boolean" ||
      typeof (signal as { addEventListener?: unknown }).addEventListener !== "function" ||
      typeof (signal as { removeEventListener?: unknown }).removeEventListener !== "function")
  ) {
    throw new Error("reason: signal must be an AbortSignal when given");
  }
}

export async function runReason(input: ReasonInput, deps: ReasonDeps): Promise<ReasonOutput> {
  validateReasonRequest(input, deps);
  const schema = inlineSchemaRefs(deps.schema) as Record<string, unknown>;
  const images = input.frames.map((f) => f.dataUrl);
  let prompt = deps.prompt;
  let lastErrors: string[] = [];
  // Best schema-valid candidate so far: the filtered output plus its
  // remaining validation errors. Shape failures never become a
  // candidate, so a returned result always parsed and passed the
  // shape check, per the 2026-10-27 9:55 AM guard.
  let best: { output: ReasonOutput; errs: string[] } | null = null;

  for (let attempt = 0; attempt < 2; attempt++) {
    // A caller throw after billing (e.g. MetaCallError on a non-JSON
    // response) still spent money: record it before rethrowing, or
    // the route total misses the failed-parse spend. A tracker throw
    // here is a spike-cap stop and replaces the original error, as on
    // the success path. No retry: a throw is not a shape failure.
    let res: Awaited<ReturnType<typeof deps.callSpark>>;
    try {
      res = await deps.callSpark({ model: SPARK_MODEL, prompt, images, schema, temperature: SPARK_TEMPERATURE, signal: deps.signal });
    } catch (err) {
      recordFailedCall(deps.tracker, failedCallModel(err, SPARK_MODEL), "reason", err);
      throw err;
    }
    // The tracker enforces the spike cap: a throw here stops the run.
    // Record the model the caller actually used: the Baseten adapter
    // reports its configured model, so the route's done log line names
    // it instead of muse-spark-1.3 in baseten mode (2026-10-27
    // 12:05 PM review). The Meta path omits it and keeps the
    // requested model.
    deps.tracker.record({ model: res.model ?? SPARK_MODEL, step: "reason", latencyMs: res.latencyMs, costUsd: res.costUsd });

    const shapeErrs = shapeProblems(res.json);
    if (shapeErrs.length > 0) {
      lastErrors = shapeErrs;
    } else {
      const rawOut = res.json as ReasonOutput;
      const filtered = filterAndRenumber(rawOut);
      const errs = validateReason(input, filtered);
      if (errs.length === 0) {
        logReasonFilterIfLossy(rawOut, filtered);
        return filtered;
      }
      lastErrors = errs;
      if (best === null || errs.length < best.errs.length) {
        logReasonFilterIfLossy(rawOut, filtered);
        best = { output: filtered, errs };
      }
    }
    if (attempt === 0) {
      prompt = `${deps.prompt}\n\nThe previous output failed validation. Fix these problems and return the full corrected JSON:\n${lastErrors.map((e) => `- ${e}`).join("\n")}`;
    }
  }
  if (best !== null) return { ...best.output, warnings: best.errs };
  throw new Error(`reason: no schema-valid result after retry:\n${lastErrors.map((e) => `- ${e}`).join("\n")}`);
}




