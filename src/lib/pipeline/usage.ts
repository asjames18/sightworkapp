/**
 * SightWork pipeline usage tracking.
 *
 * Every Meta Model API call the pipeline would make is recorded here:
 * model, pipeline step, latency, cost, and the running total against
 * the per-run spike cap and the $150 Meta credit total. This module
 * makes no API calls itself; it only records what the pipeline reports.
 *
 * SPIKE_CAP_USD is a per-run runaway guard, not the cumulative Meta
 * budget: createUsageTracker() is made fresh per request in /api/plan
 * and /api/transcribe, so the cap applies to one run (a full real run
 * costs about $0.65-$1.15). The cumulative budget across paid test
 * runs is tracked separately in the spend log and is NOT this
 * constant, so raising that budget does not raise this cap.
 *
 * The spike cap is enforced in code: recording a call that would push
 * the spike total over SPIKE_CAP_USD throws, so a run stops instead of
 * silently overspending. For a full run after the spike, pass a higher
 * spikeCapUsd; the credit total is still tracked.
 */

export const SPIKE_CAP_USD = 10;
export const CREDIT_TOTAL_USD = 150;

/** One recorded (or would-be) model call. */
export interface UsageRecord {
  /** e.g. "muse-spark", "sam-3.1", "muse-image", "muse-voice-transcribe". */
  model: string;
  /** Pipeline step, e.g. "transcribe", "reason", "render-after". */
  step: string;
  /** Wall-clock latency of the call, milliseconds. */
  latencyMs: number;
  /** Estimated cost of the call, USD. */
  costUsd: number;
  /** ISO timestamp of when the call finished. */
  at: string;
}

/** Running totals for a run. */
export interface UsageTotals {
  calls: number;
  spikeTotalUsd: number;
  remainingSpikeUsd: number;
  remainingCreditUsd: number;
}

export interface UsageTracker {
  /** Record a call. Throws if the model, step, or supplied at is blank or unparseable, the cost is invalid, or the call would break the spike cap. */
  record(input: Omit<UsageRecord, "at"> & { at?: string }): UsageRecord;
  /** True when adding costUsd would stay within the spike cap. */
  canSpend(costUsd: number): boolean;
  totals(): UsageTotals;
  records(): readonly UsageRecord[];
  /** Per-model call counts and costs, in first-seen model order. */
  totalsByModel(): UsageModelTotals[];
}

/** Call count and cost for one model over a run. */
export interface UsageModelTotals {
  model: string;
  calls: number;
  totalUsd: number;
}

// Costs are kept to 4 decimals, not 2: a sub-cent call (e.g. a SAM
// segment at $0.0025) rounds to $0 at 2 decimals, so 120 such calls
// logged $0 total and the spike cap never saw the spend. Four decimals
// keeps a $0.0025 call exact and still rounds away float dust on the
// running total (120 x $0.0025 sums to exactly $0.30).
function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

export function createUsageTracker(opts?: {
  spikeCapUsd?: number;
  creditTotalUsd?: number;
}): UsageTracker {
  // A non-object opts from a direct caller (a string, a number, an
  // array, null) used to be silently ignored: opts?.spikeCapUsd
  // reads undefined off it, so the tracker ran on defaults while
  // the caller believed it had set a cap — the same silent-config
  // failure the cap checks below already reject. Reject it here,
  // before any field is read, the same named-error rule the
  // record guard follows. Omitted opts still defaults.
  if (
    opts !== undefined &&
    (opts === null || typeof opts !== "object" || Array.isArray(opts))
  ) {
    throw new Error("usage: opts must be an object when given");
  }
  // A bad cap would silently break the spike accounting: a NaN cap
  // makes canSpend false and every record throw, a negative cap
  // throws on the first record with a misleading cap message, and a
  // bad credit total corrupts remainingCreditUsd. Reject bad opts
  // up front, at tracker creation, instead of at first record.
  if (
    opts?.spikeCapUsd !== undefined &&
    (!Number.isFinite(opts.spikeCapUsd) || opts.spikeCapUsd < 0)
  ) {
    throw new Error(`usage: spikeCapUsd must be a finite number >= 0, got ${opts.spikeCapUsd}`);
  }
  if (
    opts?.creditTotalUsd !== undefined &&
    (!Number.isFinite(opts.creditTotalUsd) || opts.creditTotalUsd < 0)
  ) {
    throw new Error(
      `usage: creditTotalUsd must be a finite number >= 0, got ${opts.creditTotalUsd}`,
    );
  }
  const spikeCapUsd = opts?.spikeCapUsd ?? SPIKE_CAP_USD;
  const creditTotalUsd = opts?.creditTotalUsd ?? CREDIT_TOTAL_USD;
  const seen: UsageRecord[] = [];
  let total = 0;

  return {
    record(input) {
      // A null, undefined, or non-object input would otherwise throw
      // a raw TypeError reading .model off it, surfacing internals
      // instead of the caller and the cause — the same named-error
      // rule the field checks below already follow. Reject it here,
      // before any field is read. An array slips past that check
      // alone (arrays are objects): one carrying every field
      // (including a parseable at, overriding Array.prototype.at)
      // would otherwise be recorded as a call, and any other array
      // throws a misleading field error instead of this named one
      // — the same array hole the opts guard above already closes.
      if (input === null || typeof input !== "object" || Array.isArray(input)) {
        throw new Error(
          `usage: record input must be an object, got ${input === null ? "null" : Array.isArray(input) ? "array" : typeof input}`,
        );
      }
      // Normalize before validating: a padded label (" muse-spark ")
      // used to be stored padded, so the spike log showed it as a
      // different model/step than the clean label, while a padded
      // timestamp was rejected outright even though it parses once
      // trimmed. Trimming all three first keeps labels attributable
      // and timestamps accepted on the same rule.
      const model = typeof input.model === "string" ? input.model.trim() : input.model;
      const step = typeof input.step === "string" ? input.step.trim() : input.step;
      const at = typeof input.at === "string" ? input.at.trim() : input.at;
      // Spike tracking attributes every call by model/step, so a
      // blank label would leave a server log line unattributable
      // and break per-model accounting against the $150 credits.
      if (typeof model !== "string" || model.length === 0) {
        throw new Error(`usage: model must be a non-empty string, got ${JSON.stringify(input.model)}`);
      }
      if (typeof step !== "string" || step.length === 0) {
        throw new Error(`usage: step must be a non-empty string, got ${JSON.stringify(input.step)}`);
      }
      // A caller-supplied timestamp is stored in the spike
      // log, so a blank, non-string, or unparseable at would leave a
      // log line undated (or unsortable) and break ordering against
      // the $150 credits. Omitted at still defaults to now; only a
      // supplied value is checked.
      if (
        at !== undefined &&
        (typeof at !== "string" || at.length === 0 || Number.isNaN(Date.parse(at)))
      ) {
        throw new Error(`usage: at must be a parseable date string when supplied, got ${JSON.stringify(input.at)}`);
      }
      if (!Number.isFinite(input.costUsd) || input.costUsd < 0) {
        throw new Error(`usage: costUsd must be a finite number >= 0, got ${input.costUsd}`);
      }
      if (!Number.isFinite(input.latencyMs) || input.latencyMs < 0) {
        throw new Error(`usage: latencyMs must be a finite number >= 0, got ${input.latencyMs}`);
      }
      if (round4(total + input.costUsd) > spikeCapUsd) {
        throw new Error(
          `usage: spike cap $${spikeCapUsd} would be exceeded ` +
            `($${round4(total)} spent + $${round4(input.costUsd)} for ${model}/${step})`,
        );
      }
      // Normalize a supplied timestamp to ISO: a parseable but
      // non-ISO value (e.g. "Oct 28 2026") used to be stored
      // verbatim, so spike log lines sorted by `at` would order
      // wrong against the ISO timestamps the tracker itself
      // generates. Omitted at still defaults to now.
      const rec: UsageRecord = {
        model,
        step,
        latencyMs: input.latencyMs,
        costUsd: round4(input.costUsd),
        at: at === undefined ? new Date().toISOString() : new Date(at).toISOString(),
      };
      seen.push(rec);
      total = round4(total + rec.costUsd);
      // A copy, not the live log entry: a caller mutating the
      // returned record must not rewrite the spike log line.
      return { ...rec };
    },
    canSpend(costUsd: number): boolean {
      return Number.isFinite(costUsd) && costUsd >= 0 && round4(total + costUsd) <= spikeCapUsd;
    },
    totals(): UsageTotals {
      return {
        calls: seen.length,
        spikeTotalUsd: total,
        remainingSpikeUsd: round4(spikeCapUsd - total),
        remainingCreditUsd: round4(creditTotalUsd - total),
      };
    },
    totalsByModel(): UsageModelTotals[] {
      // First-seen order, not sorted: the spike log reads in the
      // order models were first called, and a sorted view would
      // hide which model the run started spending on. Totals are
      // the same rounded per-call costs the tracker already sums,
      // so the per-model totals add back to totals().spikeTotalUsd.
      const byModel = new Map<string, { calls: number; totalUsd: number }>();
      for (const r of seen) {
        const cur = byModel.get(r.model) ?? { calls: 0, totalUsd: 0 };
        cur.calls += 1;
        cur.totalUsd = round4(cur.totalUsd + r.costUsd);
        byModel.set(r.model, cur);
      }
      return [...byModel.entries()].map(([model, v]) => ({
        model,
        calls: v.calls,
        totalUsd: v.totalUsd,
      }));
    },
    records(): readonly UsageRecord[] {
      // Copies of the log and of each entry, not the live array or
      // live entries: a caller pushing to (or splicing) the returned
      // array, or mutating a returned record, must not change the
      // tracker's own record count, the order the spike log is
      // printed in, or the logged cost of a call.
      return seen.map((r) => ({ ...r }));
    },
  };
}

/**
 * Record the spend of a call that failed after billing, e.g. a Meta
 * client throw on a non-JSON response (MetaCallError carries costUsd
 * and latencyMs). Without this, a step that awaits its caller and then
 * records only on success silently drops the failed call's spend, and
 * the route total understates the run. Duck-typed, not instanceof: the
 * pipeline steps take their callers injected, so the error may be any
 * object carrying the two numbers, and usage must not import the Meta
 * client. An error without finite, non-negative cost/latency records
 * nothing. A tracker throw (spike cap) propagates: a cap breach is a
 * spending stop, and the caller must not continue to later steps.
 */
export function recordFailedCall(
  tracker: UsageTracker,
  model: string,
  step: string,
  err: unknown,
): void {
  if (!err || typeof err !== "object") return;
  const costUsd = (err as { costUsd?: unknown }).costUsd;
  const latencyMs = (err as { latencyMs?: unknown }).latencyMs;
  if (
    typeof costUsd !== "number" ||
    !Number.isFinite(costUsd) ||
    costUsd < 0 ||
    typeof latencyMs !== "number" ||
    !Number.isFinite(latencyMs) ||
    latencyMs < 0
  ) {
    return;
  }
  tracker.record({ model, step, latencyMs, costUsd });
}

/**
 * The model a failed call ran on: the error's own model when it names
 * one (BasetenCallError carries its configured model), else the
 * caller's fallback (the requested model). Keeps a billed-but-failed
 * Baseten reason/review call on the Baseten model in per-model totals
 * instead of misattributing it to muse-spark-1.3, matching the success
 * path's `res.model ?? SPARK_MODEL`.
 */
export function failedCallModel(err: unknown, fallback: string): string {
  if (err && typeof err === "object") {
    const model = (err as { model?: unknown }).model;
    if (typeof model === "string" && model.trim().length > 0) return model;
  }
  return fallback;
}
