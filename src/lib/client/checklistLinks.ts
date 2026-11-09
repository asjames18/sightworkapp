import type { Issue } from "@/lib/types";
import { areaFor } from "@/lib/checklist";

/**
 * Ranks of the problems counted under one checklist area, lowest first, each once, so the "What SightWork
 * checked" row can link straight to those problem cards. Ranks that are not positive whole numbers are left
 * out, since they have no card to land on.
 */
export function areaProblemRanks(issues: readonly (Pick<Issue, "hazard" | "rank"> & { checklistKey?: unknown })[], areaId: string): number[] {
  const out = new Set<number>();
  for (const issue of issues) {
    if (Number.isInteger(issue.rank) && issue.rank > 0 && areaFor(issue) === areaId) out.add(issue.rank);
  }
  return [...out].sort((a, b) => a - b);
}

/** Spoken name for an area's problem links, e.g. "Problems in Electrical: 2 and 5". */
export function areaProblemsLabel(label: string, ranks: readonly number[]): string {
  if (ranks.length === 0) return "";
  const list = ranks.length === 1 ? `${ranks[0]}` : `${ranks.slice(0, -1).join(", ")} and ${ranks[ranks.length - 1]}`;
  return `${ranks.length === 1 ? "Problem" : "Problems"} in ${label}: ${list}`;
}
