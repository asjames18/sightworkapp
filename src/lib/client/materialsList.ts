import type { WorkPlan } from "@/lib/types";
import { materialsNeededBy, neededByLine } from "./materialsNeededBy";

/**
 * Materials shopping list: which materials are already in hand, kept on this device per plan so whoever
 * does the buying can tick items off in the store and come back later. Browser only; storage can be full
 * or off, so every call fails quietly.
 */
const PREFIX = "sightwork:materials:v1:";
/** Fired on window after the ticks for a plan change, so the work steps can show which steps have their materials. */
export const MATERIALS_CHANGED_EVENT = "sightwork:materials-changed";
/** Oldest entries are dropped past this many plans, so storage never grows without bound. */
const MAX_PLANS = 20;

type PlanMaterials = Pick<WorkPlan, "spaceName" | "materials">;
type Stored = { got: number[]; at: number };

/** Stable key for a plan: its name plus its material lines in order (FNV-1a hash), so a new run gets a fresh list. */
export function planMaterialsKey(plan: PlanMaterials): string {
  const src = [plan.spaceName, ...plan.materials.map((m, i) => `${i}:${m.item}:${m.qty}`)].join("\u0001");
  let h = 0x811c9dc5;
  for (let i = 0; i < src.length; i++) {
    h ^= src.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return PREFIX + h.toString(36);
}

/** Indexes (into plan.materials) already ticked as got, limited to items that still exist. */
export function loadGotMaterials(plan: PlanMaterials): number[] {
  try {
    const raw = window.localStorage.getItem(planMaterialsKey(plan));
    if (!raw) return [];
    const saved = JSON.parse(raw) as Stored;
    if (!saved || !Array.isArray(saved.got)) return [];
    const n = plan.materials.length;
    return [...new Set(saved.got.filter((i) => Number.isInteger(i) && i >= 0 && i < n))].sort((a, b) => a - b);
  } catch {
    return [];
  }
}

/** Saves the ticked items; an empty list removes the entry. Returns false when storage refused it. */
export function saveGotMaterials(plan: PlanMaterials, got: number[]): boolean {
  const key = planMaterialsKey(plan);
  try {
    const ls = window.localStorage;
    if (got.length === 0) {
      ls.removeItem(key);
      notify(key);
      return true;
    }
    const value: Stored = { got: [...new Set(got)].sort((a, b) => a - b), at: Date.now() };
    ls.setItem(key, JSON.stringify(value));
    prune(ls);
    notify(key);
    return true;
  } catch {
    return false;
  }
}

function notify(key: string) {
  try {
    window.dispatchEvent(new CustomEvent(MATERIALS_CHANGED_EVENT, { detail: { key } }));
  } catch {}
}

function prune(ls: Storage) {
  if (typeof ls.length !== "number" || typeof ls.key !== "function") return;
  const entries: { key: string; at: number }[] = [];
  for (let i = 0; i < ls.length; i++) {
    const k = ls.key(i);
    if (!k || !k.startsWith(PREFIX)) continue;
    let at = 0;
    try {
      at = Number((JSON.parse(ls.getItem(k) ?? "{}") as Stored).at) || 0;
    } catch {}
    entries.push({ key: k, at });
  }
  if (entries.length <= MAX_PLANS) return;
  entries.sort((a, b) => a.at - b.at);
  for (const e of entries.slice(0, entries.length - MAX_PLANS)) ls.removeItem(e.key);
}

/** "3 of 7 items in hand", "Everything is in hand", or "" when nothing is ticked. */
export function gotLine(got: number, total: number): string {
  if (total === 0 || got === 0) return "";
  if (got >= total) return total === 1 ? "The item is in hand." : `All ${total} items in hand.`;
  return `${got} of ${total} item${total === 1 ? "" : "s"} in hand.`;
}

const clean = (s: string) => s.replace(/\s+/g, " ").trim();
const usd = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

/** Leading number of a qty string ("12 chairs" -> 12, "1 box" -> 1, none -> 1): the same rule the cost step uses. */
export function qtyCount(qty: string): number {
  const m = /^\s*(\d+(?:\.\d+)?)/.exec(qty);
  const n = m ? Number(m[1]) : 1;
  return Number.isFinite(n) && n > 0 ? n : 1;
}

export interface MaterialsSpend {
  /** Summed low/high of qty x unit price over the counted items, rounded to whole dollars. */
  low: number;
  high: number;
  /** Items still needed that carry a price. */
  priced: number;
  /** Items still needed with no price on them. */
  unpriced: number;
}

/**
 * Rough spend on the materials still needed (everything not ticked as in hand), from the per-item prices
 * on the plan. Null when no needed item has a price, so example and older plans show nothing.
 */
export function materialsSpend(plan: Pick<WorkPlan, "materials">, got: number[] = []): MaterialsSpend | null {
  const have = new Set(got);
  let low = 0;
  let high = 0;
  let priced = 0;
  let unpriced = 0;
  plan.materials.forEach((m, i) => {
    if (have.has(i)) return;
    const c = m.unitCost;
    if (!c || !Number.isFinite(c[0]) || !Number.isFinite(c[1])) {
      unpriced++;
      return;
    }
    const q = qtyCount(m.qty);
    const lo = Math.max(0, Math.min(c[0], c[1]));
    const hi = Math.max(0, c[0], c[1]);
    low += q * lo;
    high += q * hi;
    priced++;
  });
  if (priced === 0) return null;
  return { low: Math.round(low), high: Math.round(high), priced, unpriced };
}

/**
 * One sentence for the list and the shared text, e.g.
 * "Materials to buy: about $120-$180 for 4 items. 1 more has no price yet."
 * Uses "Still to buy" once something is ticked. Labor is not included; "" when nothing needed is priced.
 */
export function spendLine(spend: MaterialsSpend | null, opts: { started?: boolean; dash?: string } = {}): string {
  if (!spend) return "";
  const dash = opts.dash ?? "\u2013";
  const money = spend.low === spend.high ? usd(spend.low) : `${usd(spend.low)}${dash}${usd(spend.high)}`;
  const lead = opts.started ? "Still to buy" : "Materials to buy";
  const items = `${spend.priced} item${spend.priced === 1 ? "" : "s"}`;
  const rest = spend.unpriced
    ? ` ${spend.unpriced} more ${spend.unpriced === 1 ? "has" : "have"} no price yet.`
    : "";
  return `${lead}: about ${money} for ${items}, materials only.${rest}`;
}

/**
 * The still-needed materials as plain text, for whoever is doing the buying.
 * Each line carries its quantity, the problems it fixes and a per-unit price estimate when the plan has one.
 * Returns "" when everything is already in hand.
 */
export function shoppingListText(
  plan: PlanMaterials & Partial<Pick<WorkPlan, "workOrder">>,
  got: number[] = [],
  opts: { sample?: boolean; now?: Date } = {},
): string {
  const have = new Set(got);
  // With a date, each line also says which step first needs it and when that step starts (same schedule as Add to calendar).
  const neededBy = opts.now && plan.workOrder?.length ? materialsNeededBy({ materials: plan.materials, workOrder: plan.workOrder }, opts.now) : null;
  const need = plan.materials.map((m, i) => ({ m, by: neededBy?.[i] ?? null })).filter((_, i) => !have.has(i));
  if (need.length === 0) return "";
  const lines = [`Shopping list: ${clean(plan.spaceName) || "Walkthrough"}`];
  if (opts.sample) lines.push("(Example plan with sample data, not a real run.)");
  if (have.size > 0) lines.push(`${need.length} still needed, ${plan.materials.length - need.length} already in hand.`);
  lines.push("");
  for (const { m, by } of need) {
    const extra = [
      m.forIssues?.length ? `for #${m.forIssues.join(", #")}` : null,
      by ? neededByLine(by).replace(/^Needed/, "needed") : null,
      m.unitCost ? `about ${m.unitCost[0] === m.unitCost[1] ? usd(m.unitCost[0]) : `${usd(m.unitCost[0])}-${usd(m.unitCost[1])}`} each` : null,
      m.note ? clean(m.note) : null,
    ]
      .filter(Boolean)
      .join("; ");
    lines.push(`[ ] ${clean(m.item)}: ${clean(m.qty)}${extra ? ` (${extra})` : ""}`);
  }
  const spend = spendLine(materialsSpend(plan, got), { started: have.size > 0, dash: "-" });
  if (spend) lines.push("", spend);
  lines.push("", need.some(({ m }) => m.unitCost) ? "Prices are rough estimates, not quotes. Made with SightWork." : "Made with SightWork.");
  return lines.join("\n");
}

/** Label for the toggle that hides items already in hand, so a long list in a store shows only what's left. */
export function hideGotLabel(got: number, hidden: boolean): string {
  if (hidden) return "Show all items";
  return got === 1 ? "Hide the 1 in hand" : `Hide the ${got} in hand`;
}

/** Whether the "hide in hand" toggle is worth showing: something is ticked and something is still left. */
export function canHideGot(got: number, total: number): boolean {
  return total > 1 && got > 0 && got < total;
}

/** Short note shown while items in hand are hidden ("2 in hand hidden."), or "" when nothing is hidden. */
export function hiddenGotLine(got: number, hidden: boolean): string {
  if (!hidden || got <= 0) return "";
  return `${got} in hand hidden.`;
}
