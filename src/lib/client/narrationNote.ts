import type { WorkPlan } from "@/lib/types";

/** True when this run tried to transcribe the narration and the call failed (the plan comes from the video alone). */
export function transcribeFailed(plan: WorkPlan): boolean {
  return plan.meta?.skipped?.transcribe === true;
}

/** Word for the plan's metadata row when nothing was transcribed. */
export function noNarrationTag(plan: WorkPlan): string {
  return transcribeFailed(plan) ? "narration not transcribed" : "no narration";
}

/**
 * Note shown when a plan has no transcript. A failed transcribe call must not claim the video had no speech:
 * the person may have talked the whole way through.
 */
export function noNarrationNote(plan: WorkPlan): { lead: string; hint: string } {
  if (transcribeFailed(plan)) {
    return {
      lead: "We couldn't transcribe the narration this run, so everything here comes from what the camera saw.",
      hint: "Run it again to compare what you said with what it sees.",
    };
  }
  return {
    lead: "No narration in this video, so everything here comes from what the camera saw.",
    hint: "Talk through what you're worried about next time and SightWork will compare what you said with what it sees.",
  };
}
