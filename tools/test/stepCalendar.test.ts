/** "Add steps to calendar" (.ics): scheduling on weekdays 9 to 5, escaping, folding, the event text. No network. */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  calendarFileName,
  calendarSummary,
  foldLine,
  icsEscape,
  nextWorkday,
  planCalendar,
  scheduleSteps,
  stepHours,
} from "@/lib/client/stepCalendar";
import type { WorkPlan, WorkStep } from "@/lib/types";

const step = (order: number, hours?: [number, number], extra: Partial<WorkStep> = {}): WorkStep => ({
  order, title: `Step title ${order}`, detail: `Do thing ${order}.`, hours, ...extra,
});
const plan = (workOrder: WorkStep[]): WorkPlan => ({
  spaceName: "Sanctuary stage", generatedFrom: "Walkthrough video", inventory: [],
  issues: [
    { rank: 1, title: "Cable across walkway", detail: "", severity: "high", frameIndex: 0, frameTimeSec: 3, unmentioned: true },
    { rank: 2, title: "Loose carpet seam", detail: "", severity: "medium", frameIndex: 1, frameTimeSec: 9, unmentioned: false },
  ],
  materials: [], workOrder, afterImageUrl: null, transcript: null,
});
// Saturday Oct 31, 2026, 5:30 PM local.
const SAT = new Date(2026, 9, 31, 17, 30);
const hm = (d: Date) => `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;

test("next workday skips the weekend and starts at 9 AM", () => {
  assert.equal(hm(nextWorkday(SAT)), "11/2 9:00");
  assert.equal(hm(nextWorkday(new Date(2026, 10, 3, 8, 0))), "11/4 9:00");
  assert.equal(hm(nextWorkday(new Date(2026, 10, 6, 12, 0))), "11/9 9:00");
});

test("step hours: midpoint rounded up to the half hour, default when missing or bad", () => {
  assert.deepEqual(stepHours({ hours: [1, 2] }), { hours: 1.5, estimated: false });
  assert.deepEqual(stepHours({ hours: [1, 1.2] }), { hours: 1.5, estimated: false });
  assert.deepEqual(stepHours({ hours: [0, 0.2] }), { hours: 0.5, estimated: false });
  assert.deepEqual(stepHours({ hours: [3, 1] }), { hours: 2, estimated: false });
  assert.deepEqual(stepHours({}), { hours: 2, estimated: true });
  assert.deepEqual(stepHours({ hours: [Number.NaN, 2] }), { hours: 2, estimated: true });
  assert.deepEqual(stepHours({ hours: [0, 0] }), { hours: 2, estimated: true });
});

test("steps run back to back; a step that won't fit today starts tomorrow; a long step splits across days", () => {
  const blocks = scheduleSteps([step(2, [3, 3]), step(1, [2, 2]), step(3, [4, 4]), step(4, [10, 10])], SAT);
  assert.deepEqual(
    blocks.map((b) => `${b.order}.${b.part}/${b.parts} ${hm(b.start)}-${hm(b.end)}`),
    [
      "1.1/1 11/2 9:00-11/2 11:00",
      "2.1/1 11/2 11:00-11/2 14:00",
      "3.1/1 11/3 9:00-11/3 13:00",
      "4.1/2 11/3 13:00-11/3 17:00",
      "4.2/2 11/4 9:00-11/4 15:00",
    ],
  );
});

test("a multi-day step skips the weekend", () => {
  const blocks = scheduleSteps([step(1, [20, 20])], new Date(2026, 10, 4, 10, 0)); // Wed → Thu, Fri, Mon
  assert.deepEqual(blocks.map((b) => hm(b.start)), ["11/5 9:00", "11/6 9:00", "11/9 9:00"]);
  assert.equal(hm(blocks[2].end), "11/9 13:00");
});

test("escaping and folding follow RFC 5545", () => {
  assert.equal(icsEscape("a,b;c\\d\ne"), "a\\,b\\;c\\\\d\\ne");
  const long = `SUMMARY:${"é".repeat(60)}`;
  const folded = foldLine(long);
  for (const line of folded.split("\r\n")) assert.ok(new TextEncoder().encode(line).length <= 75);
  assert.equal(folded.replace(/\r\n /g, ""), long);
  assert.equal(foldLine("SHORT:x"), "SHORT:x");
});

test("the calendar has one event per block with the step, who, what it fixes and what it waits on", () => {
  const ics = planCalendar(
    plan([
      step(1, [1, 2], { trade: "Volunteer crew", fixes: [1] }),
      step(2, undefined, { title: "Re-tape, carpet; seam", fixes: [2, 9], dependsOn: 1, trade: "Flooring contractor" }),
    ]),
    SAT,
  );
  assert.ok(ics.startsWith("BEGIN:VCALENDAR\r\nVERSION:2.0\r\n"));
  assert.ok(ics.endsWith("END:VCALENDAR\r\n"));
  const unfolded = ics.replace(/\r\n /g, "");
  assert.equal((unfolded.match(/BEGIN:VEVENT/g) ?? []).length, 2);
  assert.match(unfolded, /DTSTART:20261102T090000\r\nDTEND:20261102T103000/);
  assert.match(unfolded, /DTSTART:20261102T103000\r\nDTEND:20261102T123000/);
  assert.match(unfolded, /SUMMARY:Step 2: Re-tape\\, carpet\\; seam/);
  assert.match(unfolded, /Fixes: #1 Cable across walkway/);
  assert.match(unfolded, /Fixes: #2 Loose carpet seam\\n/); // unknown rank 9 dropped
  assert.match(unfolded, /Wait for step 1 \(Step title 1\) to finish first\./);
  assert.match(unfolded, /No time estimate in the plan: 2 h held as a placeholder\./);
  assert.match(unfolded, /Who: Flooring contractor/);
  assert.match(unfolded, /DTSTAMP:\d{8}T\d{6}Z/);
  assert.match(unfolded, /X-WR-CALNAME:SightWork: Sanctuary stage/);
  for (const line of ics.split("\r\n")) assert.ok(new TextEncoder().encode(line).length <= 75, line);
});

test("UIDs are stable for the same plan and differ per block", () => {
  const p = plan([step(1, [10, 10]), step(2, [1, 1])]);
  const uids = (s: string) => s.replace(/\r\n /g, "").match(/^UID:.*$/gm) ?? [];
  const a = uids(planCalendar(p, SAT));
  assert.equal(a.length, 3);
  assert.equal(new Set(a).size, 3);
  assert.deepEqual(uids(planCalendar(p, new Date(2026, 10, 2, 8, 0))), a);
});

test("file name and the helper line", () => {
  assert.equal(calendarFileName(SAT), "sightwork-steps-2026-10-31.ics");
  assert.equal(calendarSummary([step(1, [10, 10])], SAT), "Starts Mon, Nov 2, 9 AM; 2 workdays, 9 to 5.");
  assert.equal(calendarSummary([], SAT), "");
});
