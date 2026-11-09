import { mockPlanJob, type PlanJobRunner } from "./planJob";
import { createApiPlanJob } from "./apiPlanJob";
import { createBuildPlanRequest, requestBudgetBytes } from "./buildPlanRequest";
import { narrationChunkMaxSec } from "./narrationChunks";
import { savedSpaceRequestFields } from "./spaceType";
import { byokPlanJob } from "./byokPlanJob";
import { byokEnabled, loadKey } from "./byokKey";

/** "own" runs on the user's own Meta key, in this browser (byokPlanJob.ts); "api" runs on SightWork's server. */
export type RunnerKind = "mock" | "api" | "own";

/**
 * Which runner the flow uses. The mock stays the default until /api/plan is live.
 * - Build-time default: NEXT_PUBLIC_SIGHTWORK_RUNNER=api (anything else means mock).
 * - Preview override: `?runner=api` or `?runner=mock` in the page URL wins over the env value.
 */
export function pickRunnerKind(search: string | null, envValue: string | undefined): RunnerKind {
  const fromQuery = search ? new URLSearchParams(search).get("runner") : null;
  if (fromQuery === "api" || fromQuery === "mock") return fromQuery;
  return envValue === "api" ? "api" : "mock";
}

/**
 * Defaults sent with each request. Region is not set here: apiPlanJob adds the city and state the tester
 * saved on the video card (src/lib/client/location.ts) as "City, ST", and a real run won't start without them.
 * The space type and name come from the picker on the video card, read when
 * the run starts; nothing picked sends neither, and the server keeps its own "room" and "Walkthrough".
 * The request budget comes from NEXT_PUBLIC_SIGHTWORK_MAX_REQUEST_BYTES (unset keeps 9 MB).
 */
const maxRequestBytes = requestBudgetBytes(process.env.NEXT_PUBLIC_SIGHTWORK_MAX_REQUEST_BYTES);
// The narration goes to /api/transcribe on its own (createApiPlanJob's default split), so the frames get
// the plan request's whole budget instead of what the WAV leaves.
const apiPlanJob = createApiPlanJob(
  createBuildPlanRequest({ maxRequestBytes, narrationSentSeparately: true, runContext: savedSpaceRequestFields }),
  "/api/plan",
  "/api/transcribe",
  maxRequestBytes + 128 * 1024,
  // Long takes' narration goes in chunks that each fit a request of this budget (narrationChunks.ts).
  narrationChunkMaxSec(maxRequestBytes),
);

/**
 * The retry after a run that ran out of time: the same video with fewer, smaller frames, so the reading step
 * has less to chew through and a slow stretch is less likely to push it past the limit again. The plan says
 * how many frames it used, so a lighter plan is never passed off as the full one.
 */
export const LIGHT_MAX_FRAMES = 20;
export const LIGHT_LONG_SIDE = 768;
const lightApiPlanJob = createApiPlanJob(
  createBuildPlanRequest({
    maxRequestBytes,
    narrationSentSeparately: true,
    runContext: savedSpaceRequestFields,
    maxFrames: LIGHT_MAX_FRAMES,
    longSide: LIGHT_LONG_SIDE,
  }),
  "/api/plan",
  "/api/transcribe",
  maxRequestBytes + 128 * 1024,
  narrationChunkMaxSec(maxRequestBytes),
);

/**
 * Which runner a video the user brought (recorded here or chosen) goes to. Unlike pickRunnerKind, an
 * unset NEXT_PUBLIC_SIGHTWORK_RUNNER (the public site) means a real run: someone who films their own
 * space must never be handed the example plan as if it came from their video. The example-plan preview
 * runs only when it is asked for on purpose:
 * - `?runner=mock` (or `?runner=api` to force a real run), which wins over everything else;
 * - the preview-only switches `?fail=<step>` and `?mock=nometa`;
 * - a build with NEXT_PUBLIC_SIGHTWORK_RUNNER=mock set explicitly (the local e2e build).
 * When own-key mode is on and a key is saved in this browser (`hasOwnKey`), the run goes to the own-key
 * runner instead of SightWork's server; the query switches above still win, so previews keep working.
 * A server run still needs the tester code (see needsTesterCode), so nothing is spent without it.
 */
export function ownVideoRunnerKind(search: string | null, envValue: string | undefined, hasOwnKey = false): RunnerKind {
  const q = search ? new URLSearchParams(search) : null;
  const fromQuery = q?.get("runner");
  if (fromQuery === "api" || fromQuery === "mock") return fromQuery;
  if (q && (q.has("fail") || q.has("mock"))) return "mock";
  if (hasOwnKey) return "own";
  return envValue?.trim().toLowerCase() === "mock" ? "mock" : "api";
}

/** A real run can't start without a saved tester code: ask for it first, keeping the video. */
export function needsTesterCode(kind: RunnerKind, savedCode: string): boolean {
  return kind === "api" && !savedCode.trim();
}

/** The runner for a kind. Stable references, so a run only restarts when the video or run number changes. */
export function planJobFor(kind: RunnerKind, light = false): PlanJobRunner {
  if (kind === "own") return byokPlanJob;
  if (kind !== "api") return mockPlanJob;
  return light ? lightApiPlanJob : apiPlanJob;
}

/** The runner kind for a video the user brought, read in the browser for this page load. */
export function currentOwnVideoRunnerKind(): RunnerKind {
  const search = typeof window === "undefined" ? null : window.location.search;
  return ownVideoRunnerKind(search, process.env.NEXT_PUBLIC_SIGHTWORK_RUNNER, hasOwnKeyHere());
}

/** Own-key mode is on for this build and a key is saved in this browser. Reads the key's presence only. */
export function hasOwnKeyHere(): boolean {
  if (typeof window === "undefined" || !byokEnabled()) return false;
  return loadKey() !== "";
}
