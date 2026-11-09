/**
 * The areas SightWork's problem checklist covers (richer findings, item 1), for the plan's "What we checked"
 * summary. Each problem is counted under one area, from its checklistKey (new plans), its hazard key (today's
 * plans), or "Other". Pure, no DOM.
 */
import type { Issue } from "./types";

export interface ChecklistArea {
  id: string;
  label: string;
  /** checklistKey / hazard keys that belong here. */
  keys: readonly string[];
  /**
   * Listed only when something landed here. For any future area the plan step's sweep doesn't name for every
   * space yet, so the summary never says SightWork checked an area it wasn't asked to check. (Plumbing joined the
   * general sweep, so it is listed on every checklist plan.)
   */
  onlyWhenFound?: boolean;
}

export const CHECKLIST_AREAS: readonly ChecklistArea[] = [
  { id: "life_safety", label: "Exits and fire safety", keys: ["egress", "exit_sign", "fire_extinguisher", "fire_alarm", "blocked_aisle", "stage_edge", "steps"] },
  { id: "electrical", label: "Electrical", keys: ["exposed_wiring", "power_strip", "cord_under_rug"] },
  { id: "av", label: "AV and cables", keys: ["trip_cable", "av_unsecured", "mic_stand"] },
  { id: "lighting", label: "Lighting", keys: ["lighting"] },
  { id: "seating", label: "Seating", keys: ["damaged_seating"] },
  { id: "flooring", label: "Flooring", keys: ["flooring"] },
  { id: "walls", label: "Walls, paint and ceiling", keys: ["walls", "water_stain", "ceiling"] },
  { id: "doors", label: "Doors and windows", keys: ["doors_windows"] },
  { id: "clutter", label: "Clutter and storage", keys: ["clutter"] },
  { id: "signage", label: "Signs and wayfinding", keys: ["signage"] },
  { id: "clean", label: "Cleanliness", keys: ["cleanliness"] },
  { id: "access", label: "Accessibility", keys: ["ada_path"] },
  { id: "hvac", label: "Heating and vents", keys: ["hvac"] },
  { id: "plumbing", label: "Plumbing and water", keys: ["plumbing"] },
];

const KEY_TO_AREA = new Map(CHECKLIST_AREAS.flatMap((a) => a.keys.map((k) => [k, a.id] as const)));

/** The area id for one problem, or "other". */
export function areaFor(issue: Pick<Issue, "hazard"> & { checklistKey?: unknown }): string {
  const key = typeof issue.checklistKey === "string" ? issue.checklistKey.trim().toLowerCase() : "";
  return KEY_TO_AREA.get(key) ?? (issue.hazard ? KEY_TO_AREA.get(issue.hazard) : undefined) ?? "other";
}

export interface ChecklistRow {
  id: string;
  label: string;
  /** Ranked problems in this area. */
  found: number;
  /** Lower-confidence finds in this area. */
  watch: number;
}

/** One row per area, in checklist order, plus "Other" when anything landed there. */
export function checklistRows(issues: (Pick<Issue, "hazard"> & { checklistKey?: unknown })[], watch: { checklistKey?: unknown }[] = []): ChecklistRow[] {
  const count = (list: { hazard?: Issue["hazard"]; checklistKey?: unknown }[], id: string) => list.filter((i) => areaFor(i) === id).length;
  const rows: ChecklistRow[] = CHECKLIST_AREAS.map((a) => ({ id: a.id, label: a.label, found: count(issues, a.id), watch: count(watch, a.id) }))
    .filter((r, i) => !CHECKLIST_AREAS[i].onlyWhenFound || r.found || r.watch);
  const other = { id: "other", label: "Other", found: count(issues, "other"), watch: count(watch, "other") };
  return other.found || other.watch ? [...rows, other] : rows;
}
