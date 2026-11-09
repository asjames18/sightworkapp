/**
 * "Along your walk" timeline on the plan: one bar the length of the walkthrough, with a marker per problem at
 * the second it was seen and a tick where the speaker brought it up. It shows at a glance that SightWork
 * watched the whole walk and caught things nobody said. Pure logic, no DOM, no network.
 */
import { issueTier, type Tier } from "@/lib/planExtras";
import type { Issue, WorkPlan } from "@/lib/types";

/** Shorter walks than this (or single photos) get no timeline: there is nothing to place along it. */
export const MIN_WALK_SEC = 5;

/** Problems seen within this share of the walk of each other share one marker, so markers never overlap on a phone. */
export const MERGE_SHARE = 0.09;

/** Markers stay this far (percent) from either end of the bar, so they never hang off the edge. */
export const EDGE_PCT = 4;

export interface WalkMark {
  /** Seconds into the walk of the first problem in the marker. */
  atSec: number;
  /** Left position on the bar, percent (EDGE_PCT to 100 - EDGE_PCT). */
  pct: number;
  /** Problem ranks in this marker, in walk order. */
  ranks: number[];
  /** Worst tier among them. */
  tier: Tier;
  /** At least one of them was never mentioned in a narrated walk. */
  unsaid: boolean;
}

export interface WalkTick {
  atSec: number;
  pct: number;
  rank: number;
}

export interface WalkTimeline {
  lengthSec: number;
  marks: WalkMark[];
  said: WalkTick[];
  /** Problems on the bar. */
  seen: number;
  /** Of those, how many were never mentioned (narrated walks only, else 0). */
  unsaid: number;
}

const TIER_ORDER: Record<Tier, number> = { urgent: 0, soon: 1, later: 2 };

const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;

/** Walk length from "…, 44 s, …" in generatedFrom, else the latest time anything in the plan points at. */
export function walkLengthSec(plan: Pick<WorkPlan, "generatedFrom" | "frames" | "issues" | "transcriptTurns">): number {
  const m = /(\d+(?:\.\d+)?)\s*s\b/.exec(plan.generatedFrom ?? "");
  const stated = m ? Number(m[1]) : 0;
  let latest = 0;
  for (const f of plan.frames ?? []) if (finite(f.tSec)) latest = Math.max(latest, f.tSec);
  for (const i of plan.issues ?? []) {
    if (finite(i.frameTimeSec)) latest = Math.max(latest, i.frameTimeSec);
    if (finite(i.mention?.saidAtSec)) latest = Math.max(latest, i.mention!.saidAtSec);
  }
  for (const t of plan.transcriptTurns ?? []) {
    if (finite(t.endSec)) latest = Math.max(latest, t.endSec);
    else if (finite(t.startSec)) latest = Math.max(latest, t.startSec);
  }
  return Math.max(stated, latest);
}

function pctOf(sec: number, lengthSec: number): number {
  const raw = (sec / lengthSec) * 100;
  return Math.round(Math.min(100 - EDGE_PCT, Math.max(EDGE_PCT, raw)) * 10) / 10;
}

/**
 * Timeline for the ranked problems of a plan. `narrated` says whether "never mentioned" means anything.
 * Null when there is nothing worth drawing: no placed problems, a walk under MIN_WALK_SEC, or every problem
 * at the same second (a single photo).
 */
export function walkTimeline(plan: WorkPlan, issues: Issue[], narrated: boolean): WalkTimeline | null {
  const lengthSec = walkLengthSec(plan);
  if (!(lengthSec >= MIN_WALK_SEC)) return null;
  // A problem that was said but never seen has no place on the video, only a "said" tick.
  const placed = issues
    .filter((i) => i.status !== "mentioned_not_seen" && finite(i.frameTimeSec) && i.frameTimeSec <= lengthSec)
    .sort((a, b) => a.frameTimeSec - b.frameTimeSec || a.rank - b.rank);
  if (placed.length === 0) return null;
  if (placed.length > 1 && placed.every((i) => i.frameTimeSec === placed[0].frameTimeSec)) return null;

  const marks: WalkMark[] = [];
  for (const i of placed) {
    const tier = issueTier(i);
    const unsaid = narrated && i.unmentioned === true;
    const last = marks[marks.length - 1];
    if (last && i.frameTimeSec - last.atSec <= lengthSec * MERGE_SHARE) {
      last.ranks.push(i.rank);
      if (TIER_ORDER[tier] < TIER_ORDER[last.tier]) last.tier = tier;
      last.unsaid = last.unsaid || unsaid;
    } else {
      marks.push({ atSec: i.frameTimeSec, pct: pctOf(i.frameTimeSec, lengthSec), ranks: [i.rank], tier, unsaid });
    }
  }

  const said: WalkTick[] = narrated
    ? issues
        .filter((i) => finite(i.mention?.saidAtSec) && i.mention!.saidAtSec <= lengthSec)
        .map((i) => ({ atSec: i.mention!.saidAtSec, pct: pctOf(i.mention!.saidAtSec, lengthSec), rank: i.rank }))
        .sort((a, b) => a.atSec - b.atSec || a.rank - b.rank)
    : [];

  return {
    lengthSec,
    marks,
    said,
    seen: placed.length,
    unsaid: narrated ? placed.filter((i) => i.unmentioned === true).length : 0,
  };
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "4 problems spotted across the 44 s walk, all 4 never mentioned." */
export function walkSummary(t: WalkTimeline): string {
  const len = `${Math.round(t.lengthSec)} s`;
  const head = `${plural(t.seen, "problem", "problems")} spotted across the ${len} walk`;
  if (t.unsaid === 0) return `${head}.`;
  if (t.unsaid === t.seen) return t.seen === 1 ? `${head}, and it was never mentioned.` : `${head}, all ${t.seen} never mentioned.`;
  return `${head}, ${t.unsaid} of them never mentioned.`;
}

/** Text on a marker: "3", or "2, 4" when problems share one. */
export function markText(m: WalkMark): string {
  return m.ranks.join(", ");
}

/**
 * Accessible name for a marker. It starts with the marker's visible text so voice control users can say what
 * they see: "Problems 2, 4: seen at 32 s, Fix now, never mentioned".
 */
export function markLabel(m: WalkMark, tierLabel: string): string {
  const who = `${m.ranks.length === 1 ? "Problem" : "Problems"} ${markText(m)}`;
  return `${who}: seen at ${Math.round(m.atSec)} s, ${tierLabel}${m.unsaid ? ", never mentioned" : ""}`;
}

/**
 * The problems in the order the walk reached them, for the shared text and the PDF:
 * "In walk order: #2 at 10 s, #4 at 30 s, #1 at 50 s (never mentioned)."
 * `numberOf` maps a problem's rank to the number the reader sees next to it (the text and the PDF number
 * problems 1..n down the list). Problems that share a marker are listed one by one at their own second.
 */
export function walkOrderLine(t: WalkTimeline, issues: Issue[], numberOf: (rank: number) => number): string | null {
  const byRank = new Map(issues.map((i) => [i.rank, i]));
  const parts: string[] = [];
  for (const m of t.marks) {
    for (const rank of m.ranks) {
      const i = byRank.get(rank);
      if (!i) continue;
      const unsaid = m.unsaid && i.unmentioned === true;
      parts.push(`#${numberOf(rank)} at ${Math.round(i.frameTimeSec)} s${unsaid ? " (never mentioned)" : ""}`);
    }
  }
  return parts.length > 1 ? `In walk order: ${parts.join(", ")}.` : null;
}

/**
 * The timeline as lines of plain text for the shared text and the PDF: the summary, then the walk order.
 * Empty when the plan screen would show no timeline. Problems are numbered by their place in `issues`
 * (sorted by rank), the same numbers the text and the PDF print next to each problem.
 */
export function walkShareLines(plan: WorkPlan, issues: Issue[], narrated: boolean): string[] {
  const t = walkTimeline(plan, issues, narrated);
  if (!t) return [];
  const sorted = [...issues].sort((a, b) => a.rank - b.rank);
  const pos = new Map(sorted.map((i, n) => [i.rank, n + 1]));
  const order = walkOrderLine(t, sorted, (rank) => pos.get(rank) ?? rank);
  return order ? [walkSummary(t), order] : [walkSummary(t)];
}

/**
 * Walk lines for the shared text, which has a length cap: only when the walk caught something nobody said,
 * the part of the timeline worth the space in a group text. The PDF has no cap and uses walkShareLines.
 */
export function walkTextLines(plan: WorkPlan, issues: Issue[], narrated: boolean): string[] {
  const t = walkTimeline(plan, issues, narrated);
  return t && t.unsaid > 0 ? walkShareLines(plan, issues, narrated) : [];
}
