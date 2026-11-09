/**
 * Offline eval for SightWork plans: score a plan's problems against a labeled answer key.
 * Recall = key items the plan found; precision = plan problems that match some key item.
 * Matching is by keywords in the problem's title and detail (a key item's `any` list), so it is cheap,
 * deterministic and runs in CI with no model calls. It is a regression guard, not a substitute for a human read.
 */
import type { WorkPlan } from "../../src/lib/types";

export interface KeyItem {
  id: string;
  label: string;
  severity: "high" | "medium" | "low";
  frames?: number[];
  /** Lower-case phrases; any one appearing in a problem's title or detail counts as a match. */
  any: string[];
}

export interface AnswerKey {
  id: string;
  plan?: string;
  labeledBy?: string;
  items: KeyItem[];
}

export interface EvalResult {
  id: string;
  found: string[];
  missed: string[];
  /** Plan problem ranks that matched no key item (possible extra finds or false alarms). */
  unmatched: number[];
  recall: number;
  precision: number;
  /** Recall over the key's high-severity items only. */
  highRecall: number;
  /** Did the plan's #1 problem match a high-severity key item? */
  topIsHigh: boolean;
}

const round = (n: number) => Math.round(n * 1000) / 1000;

function matches(text: string, item: KeyItem): boolean {
  return item.any.some((p) => text.includes(p.toLowerCase()));
}

export function scorePlan(plan: Pick<WorkPlan, "issues">, key: AnswerKey): EvalResult {
  const issues = plan.issues.filter((i) => i.status !== "mentioned_not_seen");
  const texts = issues.map((i) => `${i.title} ${i.detail ?? ""}`.toLowerCase());
  const found = key.items.filter((k) => texts.some((t) => matches(t, k))).map((k) => k.id);
  const missed = key.items.filter((k) => !found.includes(k.id)).map((k) => k.id);
  const unmatched = issues.filter((_, n) => !key.items.some((k) => matches(texts[n], k))).map((i) => i.rank);
  const high = key.items.filter((k) => k.severity === "high");
  const highFound = high.filter((k) => found.includes(k.id)).length;
  const sorted = [...issues].sort((a, b) => a.rank - b.rank);
  const topText = sorted[0] ? `${sorted[0].title} ${sorted[0].detail ?? ""}`.toLowerCase() : "";
  return {
    id: key.id,
    found,
    missed,
    unmatched,
    recall: key.items.length ? round(found.length / key.items.length) : 1,
    precision: issues.length ? round((issues.length - unmatched.length) / issues.length) : 1,
    highRecall: high.length ? round(highFound / high.length) : 1,
    topIsHigh: Boolean(topText) && high.some((k) => matches(topText, k)),
  };
}
