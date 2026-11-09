import type { Issue, WorkStep } from "@/lib/types";
import { issueExtras, issueTier, TIER_LABEL } from "@/lib/planExtras";
import { SHARE_SIGNOFF } from "@/lib/client/planText";
import { stepsFixing } from "@/lib/client/stepLinks";
import type { ProblemFilterMode } from "@/lib/client/problemFilter";

/**
 * The problems the filter is showing ("You didn't mention" or "Still to fix") as one short list, for handing that
 * slice of the plan to one person by share sheet or clipboard. One line per problem, same words as the cards.
 *
 *   Problems you didn't mention · Hope City sanctuary
 *   2 of 5 problems, spotted on video but not mentioned on the walk.
 *   - #2 Loose cable across the stage edge, front left of the stage (Fix now; step 3)
 *   - #4 Exit sign out over the side door (Fix soon)
 *
 *   Made with SightWork · sightwork.vercel.app
 */
export interface ProblemsTextOptions {
  /** Every problem in the plan, for the "2 of 5" line. */
  total: number;
  spaceName?: string;
  workOrder?: readonly WorkStep[];
  /** Example or sample plan: say so, so a forwarded example is never mistaken for a real inspection. */
  sample?: boolean;
}

export type NarrowMode = Exclude<ProblemFilterMode, "all">;

const oneLine = (s: string | undefined | null) => (s ?? "").replace(/\s+/g, " ").trim();

const HEADING: Record<NarrowMode, string> = {
  unmentioned: "Problems you didn't mention",
  open: "Problems still to fix",
};

const WHY: Record<NarrowMode, string> = {
  unmentioned: "spotted on video but not mentioned on the walk",
  open: "not fixed yet by the ticked-off work steps",
};

/** Button and share-sheet wording: "Send these 2", "Send this one". */
export function sendShownLabel(count: number): string {
  return count === 1 ? "Send this one" : `Send these ${count}`;
}

export function problemsShareTitle(mode: NarrowMode, spaceName?: string): string {
  const space = oneLine(spaceName);
  return space ? `${HEADING[mode]}: ${space}` : HEADING[mode];
}

/** "#2 Loose cable across the stage edge, front left of the stage (Fix now; step 3)". */
export function problemsLine(issue: Issue, workOrder: readonly WorkStep[] | undefined): string {
  const title = oneLine(issue.title);
  const area = oneLine(issueExtras(issue).area);
  const where = area && !title.toLowerCase().includes(area.toLowerCase()) ? `, ${area}` : "";
  const orders = stepsFixing(workOrder ?? [], issue.rank);
  const steps = orders.length === 0 ? "" : orders.length === 1 ? `; step ${orders[0]}` : `; steps ${orders.slice(0, -1).join(", ")} and ${orders[orders.length - 1]}`;
  return `#${issue.rank} ${title}${where} (${TIER_LABEL[issueTier(issue)]}${steps})`;
}

/** Null when there is nothing to send. */
export function problemsToText(shown: readonly Issue[], mode: NarrowMode, opts: ProblemsTextOptions): string | null {
  const items = shown.filter((i) => oneLine(i.title) !== "");
  if (items.length === 0) return null;
  const lines: string[] = [];
  if (opts.sample) lines.push("Example plan, not a real inspection.");
  const space = oneLine(opts.spaceName);
  lines.push(space ? `${HEADING[mode]} · ${space}` : HEADING[mode]);
  const total = Math.max(opts.total, items.length);
  lines.push(`${items.length} of ${total} ${total === 1 ? "problem" : "problems"}, ${WHY[mode]}.`);
  for (const issue of items) lines.push(`- ${problemsLine(issue, opts.workOrder)}`);
  lines.push("", SHARE_SIGNOFF);
  return lines.join("\n");
}
