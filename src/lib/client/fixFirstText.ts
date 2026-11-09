import type { Issue, WorkStep } from "@/lib/types";
import type { CostShare } from "@/lib/costShares";
import { fixFirst, fixFirstCostLabel, fixFirstUnplannedLine } from "@/lib/client/fixFirst";
import { hoursLabel } from "@/lib/client/crewSummary";
import { subsetProgressLine } from "@/lib/client/stepProgress";
import { SHARE_SIGNOFF } from "@/lib/client/planText";

/**
 * Just the "Start here" card as a short text, for handing the urgent part of the plan to one person by share sheet
 * or clipboard. Same problems, steps, hours, trades and cost share as the card.
 *
 *   Start here · Hope City sanctuary
 *   2 problems are Fix now:
 *   - #1 Loose cable across the stage edge
 *   - #3 Exit sign out over the side door
 *   These 2 steps take care of them:
 *   1. Tape down cables (Volunteer, about 1 h)
 *   3. Swap the exit sign bulb (Electrician, about 1–2 h), done
 *   About 2–3 h of work · about $120–$300 of the estimate
 *   Start here: 1 of 2 done.
 *
 *   Made with SightWork · sightwork.vercel.app
 */
export interface FixFirstTextOptions {
  stepCosts?: Map<number, CostShare> | null;
  issueCosts?: Map<number, CostShare> | null;
  /** Orders of the steps ticked off on this device. */
  done?: readonly number[];
  spaceName?: string;
  /** Example or sample plan: say so, so a forwarded example is never mistaken for a real inspection. */
  sample?: boolean;
}

const oneLine = (s: string | undefined | null) => (s ?? "").replace(/\s+/g, " ").trim();
const sentence = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

const validHours = (h: WorkStep["hours"]): h is [number, number] =>
  Array.isArray(h) && h.length === 2 && h.every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0);

export const SEND_FIX_FIRST_LABEL = "Send Start here";

export function fixFirstShareTitle(spaceName?: string): string {
  const space = oneLine(spaceName);
  return space ? `Start here: ${space}` : "Start here";
}

/** "3. Swap the exit sign bulb (Electrician, about 1–2 h), done". */
export function fixFirstStepLine(order: number, step: WorkStep | undefined, opts: { done?: boolean; before?: number[] } = {}): string {
  const title = oneLine(step?.title) || `Step ${order}`;
  const trade = oneLine(step?.trade);
  const hours = step && validHours(step.hours) ? hoursLabel([Math.min(...step.hours), Math.max(...step.hours)], false) : null;
  const facts = [trade && sentence(trade), hours].filter(Boolean) as string[];
  const before = opts.before ?? [];
  const tail = [
    before.length > 0 && `needed before step${before.length > 1 ? "s" : ""} ${before.join(" and ")}`,
    opts.done && "done",
  ].filter(Boolean) as string[];
  return `${order}. ${title}${facts.length ? ` (${facts.join(", ")})` : ""}${tail.length ? `, ${tail.join(", ")}` : ""}`;
}

/** Null when the card shows nothing (no Fix now problem with a step, or the first steps are the whole plan). */
export function fixFirstToText(issues: readonly Issue[], workOrder: readonly WorkStep[], opts: FixFirstTextOptions = {}): string | null {
  const f = fixFirst(issues, workOrder, { steps: opts.stepCosts ?? null, issues: opts.issueCosts ?? null });
  if (!f) return null;
  const byRank = new Map(issues.map((i) => [i.rank, i]));
  const byOrder = new Map<number, WorkStep>();
  for (const s of workOrder) if (!byOrder.has(s.order)) byOrder.set(s.order, s);
  const done = opts.done ?? [];
  const n = f.ranks.length;

  const lines: string[] = [];
  if (opts.sample) lines.push("Example plan, not a real inspection.");
  const space = oneLine(opts.spaceName);
  lines.push(space ? `Start here · ${space}` : "Start here");
  lines.push(`${n === 1 ? "1 problem is" : `${n} problems are`} Fix now:`);
  for (const r of f.ranks) {
    const title = oneLine(byRank.get(r)?.title);
    lines.push(`- #${r}${title ? ` ${title}` : ""}`);
  }
  const them = n === 1 ? "it" : f.unplanned.length ? "most of them" : "them";
  lines.push(`${f.steps.length === 1 ? "This step takes" : `These ${f.steps.length} steps take`} care of ${them}:`);
  for (const o of f.steps) {
    const before = f.prerequisites.includes(o)
      ? workOrder.filter((s) => s.dependsOn === o && f.steps.includes(s.order)).map((s) => s.order).sort((a, b) => a - b)
      : [];
    lines.push(fixFirstStepLine(o, byOrder.get(o), { done: done.includes(o), before }));
  }
  const unplanned = fixFirstUnplannedLine(f);
  if (unplanned) lines.push(unplanned);
  const facts = [f.hours && `${sentence(f.hours)} of work`, f.cost && `${fixFirstCostLabel(f.cost)} of the estimate`].filter(Boolean) as string[];
  if (facts.length) lines.push(facts.join(" · "));
  const progress = subsetProgressLine(f.steps, done);
  if (progress) lines.push(`Start here: ${progress}`);
  const rest = f.totalSteps - f.steps.length;
  if (rest > 0) lines.push(`The other ${rest === 1 ? "step" : `${rest} steps`} can follow once these are done.`);
  lines.push("", SHARE_SIGNOFF);
  return lines.join("\n");
}
