import type { PlanJobRunner } from "./planJob";
import type { BuildPlanRequest } from "./apiPlanJob";
import { LOCATION_REQUIRED_MESSAGE } from "./apiPlanJob";
import { createBuildPlanRequest, requestBudgetBytes } from "./buildPlanRequest";
import { savedSpaceRequestFields } from "./spaceType";
import { loadRegion } from "./location";
import { loadKey } from "./byokKey";
import { withRunRegion } from "./planText";
import { createMetaClient, createCostSparkCaller, createReasonSparkCaller } from "@/lib/meta/client";
import { IMAGE_MODEL, createImageCaller } from "@/lib/meta/image";
import { createSamSegmentCaller } from "@/lib/meta/sam";
import { createAsrTranscribeCaller } from "@/lib/meta/transcribe";
import { buildReviewPrompt } from "@/lib/reviewPrompt";
import {
  COST_PROMPT_TEMPLATE,
  COST_SCHEMA,
  REASON_PROMPT_TEMPLATE,
  REASON_SCHEMA,
  buildCostPrompt,
  buildReasonPrompt,
} from "@/lib/pipeline/planPrompts";
import { createUsageTracker } from "@/lib/pipeline/usage";
import { PlanStepError, runPlan, type RunPlanDeps } from "@/lib/pipeline/runPlan";
import { uploadCheck } from "@/lib/stepChecks";
import type { PlanJobStatus, PlanRequest, WorkPlan } from "@/lib/types";

/**
 * The runner for a run on the user's own Meta key (bring your own key). The whole plan pipeline runs here in
 * the browser and calls Meta's API directly with the key saved in Settings (byokKey.ts), so the key never
 * reaches SightWork's servers and SightWork's credits are never spent. The same pipeline code the server
 * route uses (src/lib/pipeline) does the work, wired the way the route wires it in Meta mode.
 *
 * Rules kept here:
 * - The key goes only into the Meta callers' Authorization header for https://api.meta.ai. It is never put in
 *   a status, an error message, a log line or a request to this site.
 * - Errors from the pipeline show their user-facing step message; anything unexpected shows a generic line,
 *   never the raw error (which could quote a provider response).
 * - Only reachable when NEXT_PUBLIC_SIGHTWORK_BYOK is "on" and a key is saved (see selectRunner.ts).
 */

export const META_API_BASE_URL = "https://api.meta.ai/v1";

export const NO_KEY_MESSAGE = "Add your Meta API key in Settings to run this on your own key, or open the example plan.";
export const KEY_REFUSED_MESSAGE = "Meta didn't accept your API key. Check it in Settings and try again.";
export const OWN_KEY_FAIL_MESSAGE = "Building the work plan on your key failed. Nothing was sent to SightWork. Try again.";

/** The pipeline's model callers, wired to the user's key. Mirrors /api/plan in Meta mode, minus the server-only bits. */
export function ownKeyDeps(apiKey: string, fetchImpl?: typeof fetch): Omit<RunPlanDeps, "onStatus" | "signal" | "startedAtMs"> {
  const opts = { apiKey, baseUrl: META_API_BASE_URL, ...(fetchImpl ? { fetchImpl } : {}) };
  const meta = createMetaClient(opts);
  const tracker = createUsageTracker();
  const reasonCaller = createReasonSparkCaller(meta);
  return {
    transcribe: { callTranscribe: createAsrTranscribeCaller(opts), tracker },
    segment: { callSegment: createSamSegmentCaller(opts), tracker },
    reason: { prompt: REASON_PROMPT_TEMPLATE, schema: REASON_SCHEMA, callSpark: reasonCaller, tracker },
    cost: { prompt: COST_PROMPT_TEMPLATE, schema: COST_SCHEMA, callSpark: createCostSparkCaller(meta), tracker },
    renderAfter: { imageModel: IMAGE_MODEL, callImage: createImageCaller(opts), tracker },
    reasonPrompt: buildReasonPrompt,
    costPrompt: buildCostPrompt,
    review: { callSpark: reasonCaller },
    reviewPrompt: buildReviewPrompt,
    tracker,
    planProvider: "meta",
  };
}

/**
 * The transcribe step still decodes audio with Node's Buffer, which browsers don't have. Until that changes,
 * own-key runs leave the narration out (the plan is made from the frames, like a silent take) instead of
 * failing on the listening step.
 */
export function browserCanTranscribe(): boolean {
  return typeof (globalThis as { Buffer?: unknown }).Buffer !== "undefined";
}

function isAbort(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { name?: unknown }).name === "AbortError";
}

function looksLikeKeyRefused(err: unknown): boolean {
  const text = err instanceof Error ? `${err.message} ${(err as { detail?: unknown }).detail ?? ""}` : "";
  return /\b(401|403)\b/.test(text);
}

export interface ByokPlanJobOptions {
  buildRequest: BuildPlanRequest;
  getKey?: () => string;
  getRegion?: () => string;
  fetchImpl?: typeof fetch;
  canTranscribe?: () => boolean;
  /** The pipeline; tests pass a stand-in so nothing is called. */
  run?: (request: PlanRequest, deps: RunPlanDeps) => Promise<WorkPlan>;
}

export function createByokPlanJob(o: ByokPlanJobOptions): PlanJobRunner {
  const getKey = o.getKey ?? (() => loadKey());
  const getRegion = o.getRegion ?? (() => loadRegion());
  const canTranscribe = o.canTranscribe ?? browserCanTranscribe;
  const run = o.run ?? runPlan;
  return async ({ file, onStatus, signal }) => {
    const report = (s: PlanJobStatus) => {
      if (!signal.aborted) onStatus(s);
    };
    if (signal.aborted) return;
    report({ state: "running", step: "uploading" });

    const key = getKey();
    if (!key) return report({ state: "failed", step: "uploading", message: NO_KEY_MESSAGE });
    const region = getRegion();
    if (!region) return report({ state: "failed", step: "uploading", message: LOCATION_REQUIRED_MESSAGE });

    let request: PlanRequest;
    try {
      request = await o.buildRequest(file, signal);
    } catch (err) {
      if (isAbort(err) || signal.aborted) return;
      const message = err instanceof Error && err.message ? err.message : "We couldn't read that video. Try another one.";
      return report({ state: "failed", step: "uploading", message });
    }
    if (signal.aborted) return;
    if (!request.region?.trim()) request = { ...request, region };
    if (request.audioWavBase64 && !canTranscribe()) {
      const { audioWavBase64: _audio, ...rest } = request;
      void _audio;
      request = rest;
    }
    report({ state: "running", step: "uploading", check: uploadCheck(request.frames.length) });

    const deps = ownKeyDeps(key, o.fetchImpl);
    try {
      const plan = await run(request, { ...deps, onStatus: report, signal, startedAtMs: Date.now() });
      report({ state: "done", plan: withRunRegion(plan, request.region) });
    } catch (err) {
      if (isAbort(err) || signal.aborted) return;
      const costUsd = deps.tracker.totals().spikeTotalUsd;
      const cost = costUsd > 0 ? { costUsd } : {};
      if (looksLikeKeyRefused(err)) return report({ state: "failed", step: err instanceof PlanStepError ? err.step : "uploading", message: KEY_REFUSED_MESSAGE, ...cost });
      if (err instanceof PlanStepError) return report({ state: "failed", step: err.step, message: err.message, ...cost });
      report({ state: "failed", step: "planning", message: OWN_KEY_FAIL_MESSAGE, ...cost });
    }
  };
}

const maxRequestBytes = requestBudgetBytes(process.env.NEXT_PUBLIC_SIGHTWORK_MAX_REQUEST_BYTES);

/** The own-key runner the flow uses. */
export const byokPlanJob: PlanJobRunner = createByokPlanJob({
  buildRequest: createBuildPlanRequest({ maxRequestBytes, runContext: savedSpaceRequestFields }),
});
