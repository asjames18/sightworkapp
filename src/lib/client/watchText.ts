import type { WatchItem } from "@/lib/planExtras";
import { SHARE_SIGNOFF, WATCH_HEADING, watchLine } from "@/lib/client/planText";
import { watchCheckedLine } from "@/lib/client/watchChecked";

/**
 * The "Worth a closer look" finds as one short list, for handing them to whoever checks them in person.
 * One line per find (same words as the plan text), with what to look for on the line under it.
 *
 *   Worth a closer look · Kitchen
 *   2 lower-confidence finds to check in person. Not in the ranked problems or the work order.
 *   - Loose wire on the floor by the fireplace (Hearth, 36% sure)
 *     Check whether it is old or live wiring before work goes on around it.
 *
 *   Made with SightWork · sightwork.vercel.app
 */
export interface WatchTextOptions {
  spaceName?: string;
  /** Example or sample plan: say so, so a forwarded example is never mistaken for a real inspection. */
  sample?: boolean;
  /** Indexes (into the items) already checked in person on this device; those lines say so. */
  checked?: readonly number[];
}

const oneLine = (s: string | undefined | null) => (s ?? "").replace(/\s+/g, " ").trim();

/** Button wording: "Send these to check", "Send this to check". */
export function sendWatchLabel(count: number): string {
  return count === 1 ? "Send this to check" : "Send these to check";
}

export function watchShareTitle(spaceName?: string): string {
  const space = oneLine(spaceName);
  return space ? `${WATCH_HEADING}: ${space}` : WATCH_HEADING;
}

/** Null when there is nothing to send. */
export function watchToText(items: readonly WatchItem[], opts: WatchTextOptions = {}): string | null {
  const checkedSet = new Set(opts.checked ?? []);
  const list = items.map((w, i) => ({ w, checked: checkedSet.has(i) })).filter(({ w }) => oneLine(w.title) !== "");
  if (list.length === 0) return null;
  const lines: string[] = [];
  if (opts.sample) lines.push("Example plan, not a real inspection.");
  const space = oneLine(opts.spaceName);
  lines.push(space ? `${WATCH_HEADING} · ${space}` : WATCH_HEADING);
  const n = list.length;
  lines.push(`${n === 1 ? "1 lower-confidence find" : `${n} lower-confidence finds`} to check in person. Not in the ranked problems or the work order.`);
  const checkedNote = watchCheckedLine(list.filter((x) => x.checked).length, n);
  if (checkedNote) lines.push(checkedNote);
  for (const { w, checked } of list) {
    lines.push(`- ${watchLine(w)}${checked ? " — checked in person" : ""}`);
    const detail = oneLine(w.detail);
    if (detail) lines.push(`  ${detail}`);
  }
  lines.push("", SHARE_SIGNOFF);
  return lines.join("\n");
}
