/** Crew calendars: each crew's handout says when its steps fall, and its .ics holds only its steps. No network. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { crewHandoutText } from "@/lib/client/crewHandout";
import { crewSummary } from "@/lib/client/crewSummary";
import { crewCalendarFileName, fileSlug, planCalendar, stepWhen } from "@/lib/client/stepCalendar";
import type { WorkPlan } from "@/lib/types";

// Friday Oct 30, 2026, evening: the schedule starts Monday Nov 2 at 9 AM.
const now = new Date(2026, 9, 30, 18, 0, 0);

const plan: WorkPlan = {
  spaceName: "Main sanctuary stage",
  generatedFrom: "Walkthrough video",
  inventory: [],
  issues: [
    { rank: 1, title: "Cable across the steps", detail: "", severity: "high", frameIndex: 0, frameTimeSec: 2, unmentioned: true },
    { rank: 2, title: "Exit sign dark", detail: "", severity: "high", frameIndex: 1, frameTimeSec: 4, unmentioned: true },
    { rank: 3, title: "Scuffed back wall", detail: "", severity: "low", frameIndex: 2, frameTimeSec: 9, unmentioned: false },
  ],
  materials: [],
  workOrder: [
    { order: 1, title: "Reroute the stage cable", detail: "", trade: "Electrician", hours: [3, 5], fixes: [1] },
    { order: 2, title: "Paint the back wall", detail: "", trade: "Volunteers", hours: [6, 6], fixes: [3], dependsOn: 1 },
    { order: 3, title: "Replace the exit sign", detail: "", trade: "Electrician", hours: [10, 10], fixes: [2] },
  ],
} as unknown as WorkPlan;

test("stepWhen gives each step its day and hours on the starting schedule, multi-day steps per day", () => {
  const when = stepWhen(plan.workOrder, now);
  assert.equal(when.get(1), "Mon, Nov 2, 9 AM to 1 PM");
  // 6 h does not fit the 4 h left on Monday, so it starts Tuesday morning.
  assert.equal(when.get(2), "Tue, Nov 3, 9 AM to 3 PM");
  // 10 h: the rest of Tuesday, then Wednesday morning.
  assert.equal(when.get(3), "Tue, Nov 3, 3 PM to 5 PM; Wed, Nov 4, 9 AM to 5 PM");
});

test("crew calendar keeps only that crew's steps at the same times as the full calendar", () => {
  const full = planCalendar(plan, now);
  const crew = planCalendar(plan, now, { only: [1, 3], label: "Electrician" });
  assert.match(crew, /X-WR-CALNAME:SightWork: Main sanctuary stage\\, Electrician/);
  assert.match(crew, /SUMMARY:Step 1: Reroute the stage cable/);
  assert.match(crew, /SUMMARY:Step 3: Replace the exit sign \(day 1 of 2\)/);
  assert.doesNotMatch(crew, /Paint the back wall\r\n/);
  assert.doesNotMatch(crew, /step-2-1@/);
  const starts = (ics: string, n: number) => ics.match(new RegExp(`UID:[^\\r]*step-${n}-1@[\\s\\S]*?DTSTART:(\\d{8}T\\d{6})`))?.[1];
  assert.equal(starts(crew, 1), starts(full, 1));
  assert.equal(starts(crew, 3), starts(full, 3));
  assert.equal(starts(crew, 1), "20261102T090000");
  // The full calendar is unchanged by the new options.
  assert.equal(planCalendar(plan, now, {}), full);
});

test("crew file name is a safe slug", () => {
  assert.equal(fileSlug("Electrician / AV tech"), "electrician-av-tech");
  assert.equal(fileSlug("Peintre décor"), "peintre-decor");
  assert.equal(fileSlug("///"), "crew");
  assert.equal(crewCalendarFileName("Electrician / AV tech", now), "sightwork-electrician-av-tech-steps-2026-10-30.ics");
});

test("crew handout adds When lines only when asked, from the same schedule", () => {
  const row = crewSummary(plan.workOrder).rows.find((r) => r.label.toLowerCase() === "electrician")!;
  const plain = crewHandoutText(plan, row, { date: now });
  assert.doesNotMatch(plain, /When:/);
  const timed = crewHandoutText(plan, row, { date: now, scheduleFrom: now });
  assert.match(timed, /starting schedule \(weekdays 9 to 5\):/);
  assert.match(timed, /Step 1\. Reroute the stage cable \(3-5 h\)\n {3}When: Mon, Nov 2, 9 AM to 1 PM/);
  assert.match(timed, /When: Tue, Nov 3, 3 PM to 5 PM; Wed, Nov 4, 9 AM to 5 PM/);
  assert.doesNotMatch(timed, /Paint the back wall \(/);
});
