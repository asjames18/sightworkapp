import type { PlanJobRunner } from "./planJob";

/**
 * The runner for a run on the user's own Meta key (bring your own key). It will call Meta straight from
 * this browser with the key saved in Settings (byokKey.ts), so the key never reaches SightWork's servers.
 *
 * Until that browser runner is finished, it stops before doing anything and says so plainly. It makes no
 * network call, reads no key, and spends nothing. It is only reachable when NEXT_PUBLIC_SIGHTWORK_BYOK is
 * "on" and a key is saved (see selectRunner.ts), so the public site never reaches it.
 */
export const BYOK_NOT_READY_MESSAGE =
  "Runs on your own key aren't ready yet. Nothing was sent anywhere. Open the example plan, or forget your key in Settings to use SightWork's run.";

export const byokPlanJob: PlanJobRunner = async ({ onStatus, signal }) => {
  if (signal.aborted) return;
  onStatus({ state: "failed", step: "uploading", message: BYOK_NOT_READY_MESSAGE });
};
