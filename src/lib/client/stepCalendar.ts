/**
 * "Add steps to calendar": the work steps as an iCalendar (.ics) file. Steps are placed one after another on
 * weekdays, 9 AM to 5 PM, starting the next workday, in floating local time so they land at 9 AM wherever the
 * file is opened. A step longer than the rest of the day carries over into the next workday as a second block.
 * Client-only, no network.
 */
import type { WorkPlan, WorkStep } from "@/lib/types";
import { stepsWaitingOn, waitersShareLine } from "./stepWaiters";

export const DAY_START_HOUR = 9;
export const DAY_HOURS = 8;
/** Used when a step has no hours estimate. */
export const DEFAULT_STEP_HOURS = 2;

export interface CalendarBlock {
  order: number;
  /** 1-based part number when a step spans more than one day; 1 of 1 otherwise. */
  part: number;
  parts: number;
  start: Date;
  end: Date;
  /** True when the step had no hours estimate and the default was used. */
  estimated: boolean;
}

const isWeekend = (d: Date) => d.getDay() === 0 || d.getDay() === 6;

/** 9 AM on the first weekday strictly after `from` (local time). */
export function nextWorkday(from: Date): Date {
  const d = new Date(from.getFullYear(), from.getMonth(), from.getDate() + 1, DAY_START_HOUR, 0, 0, 0);
  while (isWeekend(d)) d.setDate(d.getDate() + 1);
  return d;
}

/** Midpoint of the step's hours range, rounded up to the half hour; the default when missing or invalid. */
export function stepHours(step: Pick<WorkStep, "hours">): { hours: number; estimated: boolean } {
  const h = step.hours;
  if (!h || !Number.isFinite(h[0]) || !Number.isFinite(h[1]) || h[1] <= 0) return { hours: DEFAULT_STEP_HOURS, estimated: true };
  const lo = Math.max(0, Math.min(h[0], h[1]));
  const hi = Math.max(h[0], h[1]);
  return { hours: Math.max(0.5, Math.ceil(((lo + hi) / 2) * 2) / 2), estimated: false };
}

/** Lays the steps out in plan order, back to back inside the workday, from the first workday after `from`. */
export function scheduleSteps(steps: readonly WorkStep[], from: Date): CalendarBlock[] {
  const ordered = [...steps].sort((a, b) => a.order - b.order);
  const blocks: CalendarBlock[] = [];
  let cursor = nextWorkday(from);
  const dayEnd = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), DAY_START_HOUR + DAY_HOURS, 0, 0, 0);
  for (const step of ordered) {
    const { hours, estimated } = stepHours(step);
    let left = hours * 60;
    const mine: CalendarBlock[] = [];
    while (left > 0) {
      const end = dayEnd(cursor);
      const room = (end.getTime() - cursor.getTime()) / 60000;
      // A step that fits in one full day but not in what's left of today starts fresh tomorrow.
      if (room <= 0 || (mine.length === 0 && left <= DAY_HOURS * 60 && left > room)) {
        cursor = nextWorkday(cursor);
        continue;
      }
      const take = Math.min(left, room);
      const blockEnd = new Date(cursor.getTime() + take * 60000);
      mine.push({ order: step.order, part: 0, parts: 0, start: cursor, end: blockEnd, estimated });
      left -= take;
      cursor = blockEnd;
    }
    mine.forEach((b, i) => {
      b.part = i + 1;
      b.parts = mine.length;
    });
    blocks.push(...mine);
  }
  return blocks;
}

/** iCalendar text escaping (RFC 5545 3.3.11). */
export function icsEscape(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

/** Folds a content line at 75 octets, continuing with a space (RFC 5545 3.1), never splitting a UTF-8 character. */
export function foldLine(line: string): string {
  const enc = new TextEncoder();
  if (enc.encode(line).length <= 75) return line;
  const out: string[] = [];
  let cur = "";
  let curBytes = 0;
  for (const ch of line) {
    const n = enc.encode(ch).length;
    const limit = out.length === 0 ? 75 : 74;
    if (curBytes + n > limit) {
      out.push(cur);
      cur = "";
      curBytes = 0;
    }
    cur += ch;
    curBytes += n;
  }
  out.push(cur);
  return out.join("\r\n ");
}

const pad = (n: number) => String(n).padStart(2, "0");
const floating = (d: Date) =>
  `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}00`;
const utc = (d: Date) =>
  `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
const clean = (s: string | undefined | null) => (s ?? "").replace(/\s+/g, " ").trim();

/** Short stable id for the plan, so re-importing the same plan updates events instead of duplicating them. */
function planKey(plan: Pick<WorkPlan, "spaceName" | "workOrder">): string {
  const src = `${plan.spaceName}|${plan.workOrder.map((s) => `${s.order}:${s.title}`).join("|")}`;
  let h = 2166136261;
  for (let i = 0; i < src.length; i++) {
    h ^= src.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

const span = (r: [number, number]) => (r[0] === r[1] ? `${r[0]}` : `${r[0]}–${r[1]}`);

/** Event description: the step detail, who does it, what it fixes, what it waits on and which steps wait on it. */
export function stepDescription(plan: Pick<WorkPlan, "spaceName" | "issues" | "workOrder">, step: WorkStep, block: CalendarBlock): string {
  const lines: string[] = [];
  if (clean(step.detail)) lines.push(clean(step.detail));
  if (step.trade) lines.push(`Who: ${clean(step.trade)}`);
  if (step.hours && Number.isFinite(step.hours[0]) && Number.isFinite(step.hours[1])) lines.push(`About ${span(step.hours)} h of work.`);
  else if (block.estimated) lines.push(`No time estimate in the plan: ${DEFAULT_STEP_HOURS} h held as a placeholder.`);
  const titles = new Map(plan.issues.map((i) => [i.rank, clean(i.title)]));
  const fixes = (step.fixes ?? []).filter((r) => titles.has(r));
  if (fixes.length) lines.push(`Fixes: ${fixes.map((r) => `#${r} ${titles.get(r)}`).join("; ")}`);
  if (step.dependsOn) {
    const dep = plan.workOrder.find((s) => s.order === step.dependsOn);
    lines.push(`Wait for step ${step.dependsOn}${dep ? ` (${clean(dep.title)})` : ""} to finish first.`);
  }
  const after = waitersShareLine(stepsWaitingOn(plan.workOrder, step.order));
  if (after) lines.push(after);
  lines.push(`From the SightWork plan for ${clean(plan.spaceName) || "this space"}. Times are a starting schedule. Move them as needed.`);
  return lines.join("\n");
}

export interface PlanCalendarOptions {
  /** Only these step numbers (one crew's steps). The schedule is still the whole plan's, so times match the full calendar. */
  only?: readonly number[];
  /** Added to the calendar name, e.g. the crew label. */
  label?: string;
}

/** The whole plan (or one crew's steps of it) as one .ics calendar. `now` sets the start (next workday) and DTSTAMP. */
export function planCalendar(
  plan: Pick<WorkPlan, "spaceName" | "issues" | "workOrder">,
  now: Date = new Date(),
  opts: PlanCalendarOptions = {},
): string {
  const key = planKey(plan);
  const steps = new Map(plan.workOrder.map((s) => [s.order, s]));
  const space = clean(plan.spaceName) || "Walkthrough";
  const keep = opts.only ? new Set(opts.only) : null;
  const label = clean(opts.label);
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//SightWork//Work steps//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${icsEscape(`SightWork: ${space}${label ? `, ${label}` : ""}`)}`,
  ];
  for (const b of scheduleSteps(plan.workOrder, now)) {
    if (keep && !keep.has(b.order)) continue;
    const step = steps.get(b.order)!;
    const part = b.parts > 1 ? ` (day ${b.part} of ${b.parts})` : "";
    lines.push(
      "BEGIN:VEVENT",
      `UID:sightwork-${key}-step-${b.order}-${b.part}@sightwork.vercel.app`,
      `DTSTAMP:${utc(now)}`,
      `DTSTART:${floating(b.start)}`,
      `DTEND:${floating(b.end)}`,
      `SUMMARY:${icsEscape(`Step ${b.order}: ${clean(step.title)}${part}`)}`,
      `DESCRIPTION:${icsEscape(stepDescription(plan, step, b))}`,
      `LOCATION:${icsEscape(space)}`,
      "TRANSP:OPAQUE",
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return lines.map(foldLine).join("\r\n") + "\r\n";
}

/** sightwork-steps-<yyyy-mm-dd>.ics */
export function calendarFileName(now: Date = new Date()): string {
  return `sightwork-steps-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}.ics`;
}

/** Button helper text: when the first step starts and how many workdays the steps take. */
export function calendarSummary(steps: readonly WorkStep[], now: Date = new Date()): string {
  const blocks = scheduleSteps(steps, now);
  if (!blocks.length) return "";
  const days = new Set(blocks.map((b) => b.start.toDateString())).size;
  const first = blocks[0].start.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  return `Starts ${first}, 9 AM; ${days} workday${days === 1 ? "" : "s"}, 9 to 5.`;
}

/** "Crew name" -> "crew-name" for a file name; "crew" when nothing is left. */
export function fileSlug(label: string): string {
  const slug = label
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return slug || "crew";
}

/** sightwork-<crew>-steps-<yyyy-mm-dd>.ics */
export function crewCalendarFileName(label: string, now: Date = new Date()): string {
  return calendarFileName(now).replace(/^sightwork-steps-/, `sightwork-${fileSlug(label)}-steps-`);
}

const hourLabel = (d: Date) => {
  const h = d.getHours() % 12 || 12;
  const m = d.getMinutes();
  return `${h}${m ? `:${pad(m)}` : ""} ${d.getHours() < 12 ? "AM" : "PM"}`;
};
const dayLabel = (d: Date) => d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });

/**
 * When each step falls on the starting schedule, in words: "Mon, Nov 2, 9 AM to 1 PM", and for a step that runs
 * over more than one day, "Mon, Nov 2, 9 AM to 5 PM; Tue, Nov 3, 9 AM to 12 PM". Same schedule as the .ics file.
 */
export function stepWhen(steps: readonly WorkStep[], now: Date = new Date()): Map<number, string> {
  const out = new Map<number, string[]>();
  for (const b of scheduleSteps(steps, now)) {
    const parts = out.get(b.order) ?? [];
    parts.push(`${dayLabel(b.start)}, ${hourLabel(b.start)} to ${hourLabel(b.end)}`);
    out.set(b.order, parts);
  }
  return new Map([...out].map(([k, v]) => [k, v.join("; ")]));
}
