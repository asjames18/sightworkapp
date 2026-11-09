/**
 * Light check for the picked walkthrough, shown on the upload screen before anything is sent.
 * A walk filmed with the lights off still "works", but the model can't see damage in dark corners,
 * so a real run would spend money on a thin plan. A few frames are measured on the device and the
 * user gets a soft warning while they can still film again. Pure logic, no DOM, no network.
 */
import { isBlankTake, type LumaStats } from "./blankTake";

/** How many frames are measured, spread evenly across the video. Small: this runs before every run. */
export const LIGHT_SAMPLES = 6;

/**
 * Below this average grey level (0-255) a frame is too dim to show damage. Real phone walkthroughs
 * of a dim stage measured about 37 at their darkest frame and 70 or more on most frames, so this
 * only catches takes that are dark nearly all the way through.
 */
export const DIM_MEAN = 28;

/** Share of measured frames that must be dim before the take is called dark. */
export const DIM_SHARE = 0.6;

export type LightVerdict = "ok" | "dark" | "blank";

/** Times (seconds) to measure, evenly spaced and away from the very first and last frame. */
export function lightSampleTimes(durationSec: number, count = LIGHT_SAMPLES): number[] {
  if (!(Number.isFinite(durationSec) && durationSec > 0) || count < 1) return [];
  return Array.from({ length: count }, (_, i) => (durationSec * (i + 0.5)) / count);
}

/**
 * Verdict on a take from its measured frames. Frames that couldn't be read are left out; with
 * nothing measured the take is let through ("ok") rather than guessed at.
 */
export function lightVerdict(stats: (LumaStats | null)[]): LightVerdict {
  const measured = stats.filter((s): s is LumaStats => s !== null);
  if (measured.length === 0) return "ok";
  if (isBlankTake(measured)) return "blank";
  const dim = measured.filter((s) => s.mean < DIM_MEAN).length;
  return dim / measured.length >= DIM_SHARE ? "dark" : "ok";
}

export const DARK_TAKE_MESSAGE =
  "This video looks dark for most of the walk, so SightWork may miss damage in the shadows. If you can, turn the lights on and film again. You can still go ahead with this one.";

export const BLANK_PREVIEW_MESSAGE =
  "This video looks black from start to end. Check the lens isn't covered and the lights are on, then film it again.";

/** The message to show for a verdict, or null when there's nothing to say. */
export function lightMessage(v: LightVerdict): string | null {
  return v === "dark" ? DARK_TAKE_MESSAGE : v === "blank" ? BLANK_PREVIEW_MESSAGE : null;
}
