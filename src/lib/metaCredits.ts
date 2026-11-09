/**
 * "Powered by Meta" credits: which Meta model did each step of this plan, and whether it ran.
 * Read only from the finished plan (no network), so the plan screen, the share text and the tests agree.
 * Labels only: the server decides what actually runs. Every model here is a Meta model; the plan engine is
 * either Muse Spark on the Meta Model API or Muse Spark Open (Meta open weights) hosted on Baseten.
 */
import { masksAvailable, type PlanProvider, type WorkPlan } from "./types";
import { planReview } from "./review";

export type CreditStatus = "ran" | "off" | "not_needed" | "sample" | "precomputed";

export interface MetaCredit {
  /** Plain step name, e.g. "Listen". */
  step: string;
  /** What the step does, one short phrase. */
  job: string;
  /** Meta model name as users see it. */
  model: string;
  /** Where it ran. */
  host: string;
  status: CreditStatus;
  /** One short line shown when the step didn't run or ran with nothing to do. */
  note?: string;
  /** Exact model id the server recorded for this step (plan.meta.models), only on rows that ran. */
  modelId?: string;
}

/** plan.meta.models key for each step, as the server records it. */
const STEP_MODEL_KEY: Record<string, string> = {
  Listen: "transcribe",
  "Look and count": "segment",
  "Compare and plan": "reason",
  Price: "cost",
  Picture: "image",
  Review: "review",
};

/**
 * Friendly name and host for a recorded model id ("meta-models/muse-spark-open-1026", "sam-3.1", ...).
 * null when the id isn't one we know, so the row keeps its default label and still shows the raw id.
 */
export function modelLabel(id: string): { model: string; host: string } | null {
  const k = id.trim().toLowerCase();
  if (!k) return null;
  if (k.includes("spark-open")) return { model: MODEL_NAMES.sparkOpen, host: "Meta open weights, on Baseten" };
  if (k.includes("transcribe")) return { model: MODEL_NAMES.transcribe, host: "Meta Model API" };
  if (k.includes("muse-spark")) return { model: MODEL_NAMES.spark, host: "Meta Model API" };
  if (k.includes("muse-image")) return { model: MODEL_NAMES.image, host: "Meta Model API" };
  if (/(^|[^a-z])sam[-_ ]?3/.test(k)) return { model: MODEL_NAMES.sam, host: "Meta Model API" };
  return null;
}

/**
 * Rows that ran take the model the server says actually did the step: exact id shown, and the name and host
 * follow that id (so a step that ran on Muse Spark Open isn't labeled Muse Spark). Samples and rows that
 * didn't run are left as they are. The Price row keeps its ", web search" note.
 */
function withRecordedModels(rows: MetaCredit[], models: Record<string, string> | undefined): MetaCredit[] {
  if (!models) return rows;
  return rows.map((r) => {
    const key = STEP_MODEL_KEY[r.step];
    const id = key ? models[key] : undefined;
    if (r.status !== "ran" || typeof id !== "string" || !id.trim()) return r;
    const label = modelLabel(id);
    const extra = r.host.endsWith(", web search") ? ", web search" : "";
    return label ? { ...r, model: label.model, host: label.host + extra, modelId: id.trim() } : { ...r, modelId: id.trim() };
  });
}

export const MODEL_NAMES = {
  transcribe: "Muse Voice Transcribe",
  sam: "SAM 3.1",
  spark: "Muse Spark",
  sparkOpen: "Muse Spark Open",
  image: "Muse Image",
} as const;

export function planEngine(provider: PlanProvider | undefined): { model: string; host: string } {
  return provider === "baseten"
    ? { model: MODEL_NAMES.sparkOpen, host: "Meta open weights, on Baseten" }
    : { model: MODEL_NAMES.spark, host: "Meta Model API" };
}

function hasSpeech(plan: WorkPlan): boolean {
  return Boolean(plan.transcript?.trim()) || (plan.transcriptTurns?.length ?? 0) > 0;
}

/**
 * One row per pipeline step, in run order. `sample` marks a hand-written example plan: the rows then show which
 * model WOULD do each step in a real run, and never claim one ran.
 */
export function metaCredits(plan: WorkPlan, opts: { sample?: boolean } = {}): MetaCredit[] {
  const sample = opts.sample ?? plan.meta?.isExample === true;
  const engine = planEngine(plan.meta?.planProvider);
  const api = "Meta Model API";
  const masks = masksAvailable(plan);
  const review = planReview(plan);
  const skipped = plan.meta?.skipped ?? {};
  // An explicit skip flag wins even on a sample, so the preview runner can show what a degraded run looks like.
  const s = (ran: boolean, offNote: string, skippedFlag?: boolean): Pick<MetaCredit, "status" | "note"> =>
    skippedFlag ? { status: "off", note: offNote } : sample ? { status: "sample" } : ran ? { status: "ran" } : { status: "off", note: offNote };

  const rows: MetaCredit[] = [
    {
      step: "Listen",
      job: "Turns what you say on the walkthrough into text",
      model: MODEL_NAMES.transcribe,
      host: api,
      ...(sample
        ? { status: "sample" as const }
        : skipped.transcribe
          ? { status: "off" as const, note: "Didn't finish this run, so the plan comes from the video alone" }
          : hasSpeech(plan)
          ? { status: "ran" as const }
          : { status: "not_needed" as const, note: "No speech in this video" }),
    },
    { step: "Look and count", job: "Outlines and counts what's in the room, frame by frame", model: MODEL_NAMES.sam, host: api, ...s(masks, "Counts came from the plan model instead", skipped.masks) },
    { step: "Compare and plan", job: "Checks what you said against what it saw, then writes the plan", model: engine.model, host: engine.host, ...(sample ? { status: "sample" as const } : { status: "ran" as const }) },
  ];
  if (plan.costRange || plan.meta?.skipped?.cost) {
    rows.push({ step: "Price", job: "Rough local cost range for the work", model: MODEL_NAMES.spark, host: `${api}, web search`, ...s(Boolean(plan.costRange), "Didn't finish this run", skipped.cost) });
  }
  rows.push({ step: "Picture", job: "Draws an AI concept of the finished space", model: MODEL_NAMES.image, host: api, ...s(Boolean(plan.afterImageUrl), "No after picture this time", skipped.afterImage) });
  if (review) {
    const precomputed = review.source === "precomputed";
    rows.push({
      step: "Review",
      job: "Checks every problem against its proof photo, review only",
      model: engine.model,
      host: engine.host,
      ...(precomputed
        ? { status: "precomputed" as const, note: "Worked out ahead of time for this example" }
        : sample
          ? { status: "sample" as const }
          : review.ran
            ? { status: "ran" as const }
            : { status: "off" as const, note: "Didn't run this time" }),
    });
  }
  return sample ? rows : withRecordedModels(rows, plan.meta?.models);
}

/** Distinct Meta models that actually ran for this plan, in run order (empty for samples). */
export function modelsThatRan(credits: MetaCredit[]): string[] {
  const out: string[] = [];
  for (const c of credits) if (c.status === "ran" && !out.includes(c.model)) out.push(c.model);
  return out;
}

/** One-line summary, e.g. "4 Meta models ran: Muse Voice Transcribe, SAM 3.1, Muse Spark Open, Muse Image". */
export function creditsSummary(credits: MetaCredit[]): string {
  const ran = modelsThatRan(credits);
  if (ran.length === 0) return "Sample plan written by hand. In a real run, these Meta models do each step.";
  return `${ran.length} Meta ${ran.length === 1 ? "model" : "models"} ran: ${ran.join(", ")}`;
}
