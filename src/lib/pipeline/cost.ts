/**
 * SightWork pipeline step: `estimateCost`.
 *
 * Turns the `reason` output (materials + work steps) into a rough,
 * region-grounded cost range (prompt 05 spec: prompt,
 * schema, and math rule). This file implements the call, the math,
 * and the validation.
 *
 * This module makes no API calls and holds no keys. The model caller is
 * injected by the wiring code (later: src/lib/meta), so the step is
 * testable on mock data and the spike can swap callers without touching
 * this logic. Every call is recorded on the usage tracker from ./usage.ts,
 * so the $10 spike cap is enforced in code (the tracker throws).
 *
 * Rules enforced here, in code, not trusted to the model (prompt 05):
 * - Skip rule: no region (missing or blank) means NO model call and a
 *   null result, so costRange stays null. A region is never assumed.
 * - The model returns unit prices, a labor rate, contingency, assumptions
 *   and sources; code computes the range. Totals are reproducible.
 * - Materials: qty is the leading number of the qty string, or 1 when
 *   there is none; thousands commas read as digits ("1,000" -> 1000,
 *   so a bulk qty prices as a thousand, not as one). A material with
 *   no model price gets [0, 0] plus a
 *   "No price for <item>" assumption line. A model price for a
 *   material index outside the materials array is ignored, never
 *   silently dropped: it adds an "Ignored price for material index
 *   <n>" assumption line, so a model slip stays visible on the plan
 *   instead of surfacing as a puzzling "No price" line. A second
 *   price for the same material index is likewise surfaced: it adds
 *   a "Duplicate price for material index <n>" assumption line (the
 *   last price wins), so a model slip stays visible instead of
 *   silently overwriting the first price.
 * - Ungrounded prices: a model price marked grounded: false is a
 *   national-average guess at best, never a verified local price. It
 *   is kept (dropping it would zero the material) but, when the
 *   region names a US state, it is scaled by that state's materials
 *   factor from ../regionalCost (BEA goods RPP / US average, rounded
 *   to cents — the whole-dollar rounding in applyRegionalFactors
 *   suits totals, not unit prices) and flagged per item, plus one
 *   "Adjusted for <State> with state averages (estimate)" line.
 *   With no recognizable state the price is kept unscaled and
 *   flagged as not verified. Grounded prices are never scaled.
 * - Labor: volunteer basis pays only licensed trades (electrician,
 *   plumber, roofer); contractor pays every step; mixed pays every step
 *   whose trade is not "volunteer". Steps without hours add no labor.
 * - Contingency is clamped to 10-20% and inverted pairs are swapped.
 * - Sources keep only http(s) URLs; the field is omitted when none are
 *   left. (The caller passes only web_search results; code cannot
 *   verify provenance beyond the URL shape.)
 * - Price counts: computeCostRange also returns pricedMaterials and
 *   groundedPrices (see CostResult), so a later step or the UI can
 *   report how many prices came back search-grounded. The counts are
 *   computed, never trusted to the model beyond its grounded flags.
 * - Per-problem and per-step shares (costRange.byIssue / byStep, read
 *   by src/lib/costShares.ts): every material line and every paid
 *   labor line is split equally among the issue ranks it fixes
 *   (material forIssues / step fixes), with lines that name no valid
 *   rank split equally across all issues, and contingency applied to
 *   every line at the same rates as the total; material lines are
 *   likewise split across the steps whose fixes intersect the
 *   material's forIssues (all steps when nothing intersects). Shares
 *   are then rescaled so each list sums to the rounded total, so the
 *   screen's shares add up exactly. A list is omitted when it would
 *   be empty (no issues, no steps, or a zero total).
 * - The result is validated with checkWorkPlan from ../types.
 * - The usage tracker records cost/latency per call; it has no
 *   per-call search-count field, so web_search cost is folded into the
 *   caller's costUsd (see the meta client, later).
 */

import {
  COST_LABEL,
  checkWorkPlan,
  type CostRange,
  type InventoryItem,
  type Issue,
  type LaborBasis,
  type MaterialItem,
  type WorkPlan,
  type WorkStep,
} from "../types";
import { recordFailedCall, type UsageTracker } from "./usage";
import { regionalFactors, stateFromRegion } from "../regionalCost";

/** Reason output this step consumes, plus the cost request fields. */
export interface CostInput {
  spaceName: string;
  generatedFrom: string;
  inventory: InventoryItem[];
  issues: Issue[];
  materials: MaterialItem[];
  workOrder: WorkStep[];
  /** Region for prices and labor, e.g. "Sebring, FL". Omit it and the result is null. */
  region?: string;
  laborBasis?: LaborBasis;
}

/** A model call supplied by the wiring code. Never a real call in tests. */
export interface CostCaller {
  (req: {
    model: string;
    prompt: string;
    schema: Record<string, unknown>;
    /** Abort signal for a stopped run (2026-11-01): forwarded to the model fetch. */
    signal?: AbortSignal;
  }): Promise<{ json: unknown; latencyMs: number; costUsd: number }>;
}

export interface CostDeps {
  /** Prompt text (prompt 05), with placeholders already filled. */
  prompt: string;
  /** Structured-output schema (prompt 05). Flat: no $ref, no anyOf. */
  schema: Record<string, unknown>;
  callSpark: CostCaller;
  tracker: UsageTracker;
  /**
   * Abort signal from runPlan (the route's request signal), forwarded to
   * the model caller so stopping a run can cut the in-flight cost call
   * instead of billing it to completion.
   */
  signal?: AbortSignal;
}

/** What the step returns: the range plus materials with unitCost filled in. */
export interface CostResult {
  costRange: CostRange;
  materials: MaterialItem[];
  /**
   * How many materials carry a model price (valid material index, last
   * price wins on duplicates; ignored out-of-range prices excluded).
   * Added for the processing screen's planning note (2026-10-31
   * 12:30 AM review): the UI can show how many prices came back, without
   * the pipeline overwriting the proof-frame planning check.
   */
  pricedMaterials: number;
  /**
   * Of pricedMaterials, how many prices the model marked grounded
   * (search-backed). Ungrounded prices are still counted in
   * pricedMaterials but flagged in costRange.assumptions.
   */
  groundedPrices: number;
}

/** One per-problem share, keyed by issue rank (client: costShares.ts). */
export interface IssueCostShare {
  rank: number;
  low: number;
  high: number;
}

/** One per-step share, keyed by work-step order (client: costShares.ts). */
export interface StepCostShare {
  order: number;
  low: number;
  high: number;
}

/**
 * A CostRange carrying the per-problem and per-step shares. The shared
 * CostRange type (src/lib/types.ts) does not declare these fields, so
 * they ride as extra properties here and the client reads them with
 * the same cast; checkWorkPlan ignores unknown fields, so the
 * contract check in estimateCost still passes.
 */
export type CostRangeWithShares = CostRange & {
  byIssue?: IssueCostShare[];
  byStep?: StepCostShare[];
};

/** One model-supplied unit price, keyed by material index. */
export interface ModelUnitCost {
  materialIndex: number;
  unit: string;
  unitCost: [low: number, high: number];
  grounded: boolean;
  sourceIndex?: number;
}

/** The model output for prompt 05, after shape validation. */
export interface CostModelOutput {
  unitCosts: ModelUnitCost[];
  laborRate: [low: number, high: number];
  contingencyPct: [low: number, high: number];
  assumptions: string[];
  sources: { title: string; url: string }[];
}

const SPARK_MODEL = "muse-spark-1.3";
const LICENSED_TRADE = /electrician|plumber|roofer/i;
const COMPUTED_LINE =
  "Total = materials + labor + contingency, computed from the line items";

/** Leading number of a qty string ("12 chairs" -> 12, "1 box" -> 1, "1,000 sq ft" -> 1000, none -> 1). */
export function parseQty(qty: string): number {
  const m = /^\s*(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)/.exec(qty);
  return m ? Number(m[1].replace(/,/g, "")) : 1;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function isPair(v: unknown): v is [number, number] {
  return (
    Array.isArray(v) &&
    v.length === 2 &&
    v.every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0)
  );
}

/** Swap an inverted pair so low <= high. Throws on a non-pair. */
function normalizePair(pair: unknown, what: string): [number, number] {
  if (!isPair(pair)) throw new Error(`estimateCost: ${what} must be [low, high] numbers >= 0`);
  const [lo, hi] = pair;
  return hi < lo ? [hi, lo] : [lo, hi];
}

/** Validate the model JSON shape; throw instead of guessing. */
export function parseCostModel(json: unknown): CostModelOutput {
  if (!isRecord(json)) throw new Error("estimateCost: model output is not a JSON object");
  if (!Array.isArray(json.unitCosts)) throw new Error('estimateCost: "unitCosts" is not an array');
  const unitCosts: ModelUnitCost[] = json.unitCosts.map((u, i) => {
    if (!isRecord(u)) throw new Error(`estimateCost: unitCosts[${i}] is not an object`);
    if (!Number.isInteger(u.materialIndex) || (u.materialIndex as number) < 0)
      throw new Error(`estimateCost: unitCosts[${i}].materialIndex must be an integer >= 0`);
    if (typeof u.unit !== "string") throw new Error(`estimateCost: unitCosts[${i}].unit must be a string`);
    if (typeof u.grounded !== "boolean")
      throw new Error(`estimateCost: unitCosts[${i}].grounded must be a boolean`);
    return {
      materialIndex: u.materialIndex as number,
      unit: u.unit,
      unitCost: normalizePair(u.unitCost, `unitCosts[${i}].unitCost`),
      grounded: u.grounded,
      sourceIndex:
        Number.isInteger(u.sourceIndex) && (u.sourceIndex as number) >= 0
          ? (u.sourceIndex as number)
          : undefined,
    };
  });
  if (!Array.isArray(json.assumptions) || !json.assumptions.every((a) => typeof a === "string"))
    throw new Error('estimateCost: "assumptions" must be an array of strings');
  if (!Array.isArray(json.sources)) throw new Error('estimateCost: "sources" is not an array');
  const sources = json.sources
    .filter(
      (s): s is { title: string; url: string } =>
        isRecord(s) && typeof s.title === "string" && typeof s.url === "string" && /^https?:\/\//.test(s.url),
    )
    .map((s) => ({ title: s.title, url: s.url }));
  return {
    unitCosts,
    laborRate: normalizePair(json.laborRate, "laborRate"),
    contingencyPct: normalizePair(json.contingencyPct, "contingencyPct"),
    assumptions: json.assumptions as string[],
    sources,
  };
}

/** True when this step's labor is paid under the given basis. */
function laborPaid(trade: string | undefined, basis: LaborBasis): boolean {
  const t = (trade ?? "").trim().toLowerCase();
  if (basis === "contractor") return true;
  if (basis === "mixed") return t !== "volunteer";
  return LICENSED_TRADE.test(t);
}

function round10(n: number): number {
  return Math.round(n / 10) * 10;
}

/** Split an amount equally among unique keys, adding into the accumulator. */
function splitInto(
  acc: Map<number, number>,
  amount: number,
  keys: number[],
  fallback: number[],
): void {
  const targets = keys.length > 0 ? keys : fallback;
  if (targets.length === 0 || amount === 0) return;
  const each = amount / targets.length;
  for (const k of targets) acc.set(k, (acc.get(k) ?? 0) + each);
}

/** Unique ranks from a forIssues/fixes list that exist in the plan's issues. */
function validRanks(list: number[] | undefined, known: Set<number>): number[] {
  if (!list) return [];
  return [...new Set(list)].filter((r) => known.has(r));
}

/**
 * Apply contingency and rescale a per-key subtotal map so it sums to
 * the rounded total, dropping zero entries. Rounding the total to tens
 * (round10) would otherwise leave the shares a few dollars off the
 * displayed total on small plans, past the client's 5% trust gate.
 */
function finalizeShares(
  subLo: Map<number, number>,
  subHi: Map<number, number>,
  contLo: number,
  contHi: number,
  totalLo: number,
  totalHi: number,
): { key: number; low: number; high: number }[] {
  const rawLo = new Map<number, number>();
  const rawHi = new Map<number, number>();
  for (const [k, v] of subLo) rawLo.set(k, v * (1 + contLo / 100));
  for (const [k, v] of subHi) rawHi.set(k, v * (1 + contHi / 100));
  const sumLo = [...rawLo.values()].reduce((a, b) => a + b, 0);
  const sumHi = [...rawHi.values()].reduce((a, b) => a + b, 0);
  const out: { key: number; low: number; high: number }[] = [];
  const keys = [...new Set([...rawLo.keys(), ...rawHi.keys()])].sort((a, b) => a - b);
  for (const k of keys) {
    const low = sumLo > 0 ? Math.round(((rawLo.get(k) ?? 0) * totalLo) / sumLo * 100) / 100 : 0;
    const high = sumHi > 0 ? Math.round(((rawHi.get(k) ?? 0) * totalHi) / sumHi * 100) / 100 : 0;
    if (low === 0 && high === 0) continue;
    out.push({ key: k, low, high });
  }
  return out;
}

/**
 * Pure math from prompt 05: unit prices + labor + contingency -> CostRange,
 * with each material's unitCost filled in. No model call, no tracker.
 * The optional issues list (6th arg, default none) turns on the
 * byIssue/byStep shares; older callers that omit it get exactly the
 * previous result, with no share fields attached.
 */
export function computeCostRange(
  materials: MaterialItem[],
  workOrder: WorkStep[],
  region: string,
  laborBasis: LaborBasis,
  model: CostModelOutput,
  issues: Issue[] = [],
): CostResult {
  const byIndex = new Map<number, ModelUnitCost>();
  const ignored = new Set<number>();
  const duplicates = new Set<number>();
  for (const u of model.unitCosts) {
    // parseCostModel only checks materialIndex >= 0, so an index past
    // the end of the materials array would otherwise vanish here with
    // no trace: the material it meant keeps a "No price" line and the
    // stray price is never seen. Keep it visible instead. Likewise a
    // second price for an index already seen would silently overwrite
    // the first; keep that visible too, with the last price winning.
    if (u.materialIndex < materials.length) {
      if (byIndex.has(u.materialIndex)) duplicates.add(u.materialIndex);
      byIndex.set(u.materialIndex, u);
    } else ignored.add(u.materialIndex);
  }

  const missing: string[] = [];
  const ungrounded: string[] = [];
  // An ungrounded model price is a national-average guess, not a
  // verified local price: scale it by the region's state materials
  // factor when the region names a US state, and flag it either way.
  // Grounded prices pass through untouched. Unit prices are rounded
  // to cents (applyRegionalFactors rounds to whole dollars, which
  // suits totals but would zero a sub-dollar unit price).
  const stateCode = stateFromRegion(region);
  const factors = stateCode ? regionalFactors(stateCode) : null;
  let anyScaled = false;
  const filled: MaterialItem[] = materials.map((m, i) => {
    const u = byIndex.get(i);
    if (!u) {
      missing.push(`No price for ${m.item}`);
      return { ...m, unitCost: [0, 0] as [number, number] };
    }
    if (!u.grounded) {
      if (factors) {
        anyScaled = true;
        ungrounded.push(`Ungrounded price for ${m.item} (state-adjusted estimate)`);
        const scale = (n: number) => Math.round(n * factors.materials * 100) / 100;
        const [lo, hi] = u.unitCost;
        return { ...m, unitCost: [scale(lo), scale(hi)] as [number, number] };
      }
      ungrounded.push(`Ungrounded price for ${m.item} (not verified)`);
    }
    return { ...m, unitCost: u.unitCost };
  });

  let materialsLow = 0;
  let materialsHigh = 0;
  for (const m of filled) {
    const q = parseQty(m.qty);
    const [lo, hi] = m.unitCost ?? [0, 0];
    materialsLow += q * lo;
    materialsHigh += q * hi;
  }

  let laborLow = 0;
  let laborHigh = 0;
  // Paid labor per step order, for the byStep shares (unpaid steps
  // stay at zero here; they can still carry a material share below).
  const laborByStep = new Map<number, [number, number]>();
  for (const step of workOrder) {
    if (!step.hours || !laborPaid(step.trade, laborBasis)) continue;
    const [hLo, hHi] = step.hours[0] <= step.hours[1] ? step.hours : [step.hours[1], step.hours[0]];
    const lo = hLo * model.laborRate[0];
    const hi = hHi * model.laborRate[1];
    laborLow += lo;
    laborHigh += hi;
    const prev = laborByStep.get(step.order) ?? [0, 0];
    laborByStep.set(step.order, [prev[0] + lo, prev[1] + hi]);
  }

  const [cLo, cHi] = model.contingencyPct;
  const contLo = Math.min(20, Math.max(10, cLo));
  const contHi = Math.min(20, Math.max(10, cHi));
  const subtotalLow = materialsLow + laborLow;
  const subtotalHigh = materialsHigh + laborHigh;
  const low = round10(subtotalLow * (1 + contLo / 100));
  const high = round10(subtotalHigh * (1 + contHi / 100));

  // Per-problem and per-step shares (only when the caller supplied
  // issues; without them the result is exactly the previous one, with
  // no share fields). Material
  // lines use the filled (state-scaled) unit costs, so the shares and
  // the total are built from the same numbers.
  const knownRanks = new Set(issues.map((i) => i.rank));
  const allRanks = [...knownRanks].sort((a, b) => a - b);
  const issueSubLo = new Map<number, number>();
  const issueSubHi = new Map<number, number>();
  if (issues.length > 0) {
    for (const m of filled) {
      const q = parseQty(m.qty);
      const [lo, hi] = m.unitCost ?? [0, 0];
      const keys = validRanks(m.forIssues, knownRanks);
      splitInto(issueSubLo, q * lo, keys, allRanks);
      splitInto(issueSubHi, q * hi, keys, allRanks);
    }
    for (const step of workOrder) {
      const labor = laborByStep.get(step.order);
      if (!labor) continue;
      const keys = validRanks(step.fixes, knownRanks);
      splitInto(issueSubLo, labor[0], keys, allRanks);
      splitInto(issueSubHi, labor[1], keys, allRanks);
    }
  }
  const stepSubLo = new Map<number, number>();
  const stepSubHi = new Map<number, number>();
  if (issues.length > 0 && workOrder.length > 0) {
    for (const step of workOrder) {
      const labor = laborByStep.get(step.order);
      if (labor) {
        stepSubLo.set(step.order, (stepSubLo.get(step.order) ?? 0) + labor[0]);
        stepSubHi.set(step.order, (stepSubHi.get(step.order) ?? 0) + labor[1]);
      }
    }
    for (const m of filled) {
      const q = parseQty(m.qty);
      const [lo, hi] = m.unitCost ?? [0, 0];
      if (lo === 0 && hi === 0) continue;
      // Steps that fix an issue this material fixes; all steps when
      // the material names no issue or no step touches those issues.
      const materialRanks = new Set(validRanks(m.forIssues, knownRanks));
      const targets = workOrder
        .filter((s) => (s.fixes ?? []).some((r) => materialRanks.has(r)))
        .map((s) => s.order);
      const keys = materialRanks.size > 0 && targets.length > 0
        ? [...new Set(targets)]
        : workOrder.map((s) => s.order);
      splitInto(stepSubLo, q * lo, keys, workOrder.map((s) => s.order));
      splitInto(stepSubHi, q * hi, keys, workOrder.map((s) => s.order));
    }
  }
  const byIssue = finalizeShares(issueSubLo, issueSubHi, contLo, contHi, low, high)
    .map(({ key, low: l, high: h }) => ({ rank: key, low: l, high: h }));
  const byStep = finalizeShares(stepSubLo, stepSubHi, contLo, contHi, low, high)
    .map(({ key, low: l, high: h }) => ({ order: key, low: l, high: h }));

  const costRange: CostRangeWithShares = {
    low,
    high,
    currency: "USD",
    label: COST_LABEL,
    region,
    laborBasis,
    assumptions: [
      ...model.assumptions,
      COMPUTED_LINE,
      ...missing,
      ...ungrounded,
      ...(anyScaled && factors
        ? [`Adjusted for ${factors.stateName} with state averages (estimate)`]
        : []),
      ...[...ignored].sort((a, b) => a - b).map((n) => `Ignored price for material index ${n} (no such material)`),
      ...[...duplicates].sort((a, b) => a - b).map((n) => `Duplicate price for material index ${n} (kept the last price)`),
    ],
    ...(model.sources.length > 0 ? { sources: model.sources } : {}),
    ...(byIssue.length > 0 ? { byIssue } : {}),
    ...(byStep.length > 0 ? { byStep } : {}),
  };
  return {
    costRange,
    materials: filled,
    pricedMaterials: byIndex.size,
    groundedPrices: [...byIndex.values()].filter((u) => u.grounded).length,
  };
}

/**
 * Fail fast on a bad request before any paid Spark call: a non-object
 * input or a non-array materials/workOrder used to throw a bare
 * TypeError deep inside computeCostRange, after the model call.
 */
export function validateCostInput(input: CostInput): void {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("estimateCost: input is not an object");
  }
  for (const field of ["spaceName", "generatedFrom"] as const) {
    const v = input[field];
    if (typeof v !== "string" || v.trim().length === 0) {
      throw new Error(`estimateCost: ${field} must be a non-empty string`);
    }
  }
  for (const field of ["inventory", "issues", "materials", "workOrder"] as const) {
    if (!Array.isArray(input[field])) {
      throw new Error(`estimateCost: ${field} is not an array`);
    }
  }
  if (input.region !== undefined && typeof input.region !== "string") {
    throw new Error("estimateCost: region must be a string when given");
  }
  if (
    input.laborBasis !== undefined &&
    input.laborBasis !== "volunteer" &&
    input.laborBasis !== "contractor" &&
    input.laborBasis !== "mixed"
  ) {
    throw new Error(`estimateCost: laborBasis must be volunteer, contractor or mixed, got ${input.laborBasis}`);
  }
}

/**
 * Fail fast on bad wiring after the no-region skip but before the paid
 * Spark call: a tracker without record used to throw only after the
 * call, when record ran, so the spend was already made.
 */
export function validateCostDeps(deps: CostDeps): void {
  if (deps === null || typeof deps !== "object" || Array.isArray(deps)) {
    throw new Error("estimateCost: deps is not an object");
  }
  if (typeof deps.prompt !== "string" || deps.prompt.trim().length === 0) {
    throw new Error("estimateCost: prompt must be a non-empty string");
  }
  if (!isRecord(deps.schema)) {
    throw new Error("estimateCost: schema must be an object");
  }
  if (typeof deps.callSpark !== "function") {
    throw new Error("estimateCost: callSpark must be a function");
  }
  if (
    deps.tracker === null ||
    typeof deps.tracker !== "object" ||
    typeof deps.tracker.record !== "function"
  ) {
    throw new Error("estimateCost: tracker.record is not a function");
  }
}

/**
 * Run the cost step. Returns null without calling the model when no
 * region was supplied. Otherwise one model call, tracker-recorded, then
 * the math above and a checkWorkPlan validation of the result.
 */
export async function estimateCost(input: CostInput, deps: CostDeps): Promise<CostResult | null> {
  validateCostInput(input);
  const region = input.region?.trim();
  if (!region) return null;
  validateCostDeps(deps);
  const laborBasis = input.laborBasis ?? "volunteer";

  // A billed-but-failed call (e.g. a non-JSON response) still spent
  // money: record it before rethrowing, or the route total misses
  // the failed-parse spend. A tracker throw here is a spike-cap stop
  // and replaces the original error, as on the success path. No
  // retry: a throw is not a shape failure.
  let res: Awaited<ReturnType<typeof deps.callSpark>>;
  try {
    res = await deps.callSpark({ model: SPARK_MODEL, prompt: deps.prompt, schema: deps.schema, signal: deps.signal });
  } catch (err) {
    recordFailedCall(deps.tracker, SPARK_MODEL, "estimateCost", err);
    throw err;
  }
  // The tracker enforces the spike cap: a throw here stops the run.
  deps.tracker.record({
    model: SPARK_MODEL,
    step: "estimateCost",
    latencyMs: res.latencyMs,
    costUsd: res.costUsd,
  });

  const model = parseCostModel(res.json);
  const result = computeCostRange(input.materials, input.workOrder, region, laborBasis, model, input.issues);

  const shell: WorkPlan = {
    spaceName: input.spaceName,
    generatedFrom: input.generatedFrom,
    inventory: input.inventory,
    issues: input.issues,
    materials: result.materials,
    workOrder: input.workOrder,
    afterImageUrl: null,
    transcript: null,
    costRange: result.costRange,
  };
  const errs = checkWorkPlan(shell);
  if (errs.length > 0) {
    throw new Error(`estimateCost: result failed contract check:\n${errs.map((e) => `- ${e}`).join("\n")}`);
  }
  return result;
}

