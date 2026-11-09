/** The call for help on the Volunteers row of Who does the work, as plain text. No network. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { volunteerCallText, volunteerCallTitle } from "@/lib/client/volunteerCall";
import { crewSummary } from "@/lib/client/crewSummary";
import type { WorkPlan } from "@/lib/types";

const date = new Date(2026, 9, 31);

function plan(extra: Partial<WorkPlan> = {}): WorkPlan {
  return {
    spaceName: "Main  sanctuary stage",
    generatedFrom: "Walkthrough video",
    inventory: [],
    issues: [
      { rank: 1, title: "Cable across the steps", detail: "", severity: "high", frameIndex: 0, frameTimeSec: 2, unmentioned: true },
      { rank: 2, title: "Exit sign dark", detail: "", severity: "high", frameIndex: 1, frameTimeSec: 4, unmentioned: true },
      { rank: 3, title: "Scuffed back wall", detail: "", severity: "low", frameIndex: 2, frameTimeSec: 9, unmentioned: false },
    ],
    materials: [
      { item: "Cable cover", qty: "2", forIssues: [1] },
      { item: "LED exit sign", qty: "1", forIssues: [2] },
      { item: "Eggshell paint", qty: "1 gal", forIssues: [3] },
    ],
    workOrder: [
      { order: 1, title: "Reroute the stage cable", detail: "", trade: "Electrician", hours: [1, 2], fixes: [1] },
      { order: 2, title: "Replace the exit sign", detail: "", trade: "Electrician", hours: [1, 1], fixes: [2], dependsOn: 1 },
      { order: 3, title: "Paint the back wall", detail: "Two coats.", trade: "Volunteers", hours: [3, 4], fixes: [3], dependsOn: 2 },
      { order: 4, title: "Cover the cable", detail: "", trade: "Volunteer", hours: [1, 1], fixes: [1] },
    ],
    afterImageUrl: null,
    transcript: null,
    meta: { region: "Atlanta, GA" } as WorkPlan["meta"],
    ...extra,
  };
}

const volunteers = (p: WorkPlan) => crewSummary(p.workOrder).rows.find((r) => !r.paid)!;

test("call for help names the work, the hours, the sharing, the wait on a trade and only volunteer supplies", () => {
  const p = plan();
  const text = volunteerCallText(p, volunteers(p), { date })!;
  assert.match(text, /^Volunteers needed: Main sanctuary stage\nAtlanta, GA · Oct 31, 2026\n/);
  assert.match(text, /We are fixing 2 problems here and could use your help\./);
  assert.match(text, /What volunteers will do \(about 4–5 h of work in all\):\n- Paint the back wall \(3-4 h\)\n- Cover the cable \(1 h\)/);
  assert.match(text, /Shared between 3 people, that is about 1.5 h each\.\n\n"Paint the back wall" starts/);
  assert.match(text, /"Paint the back wall" starts once the Electrician finishes "Replace the exit sign"\./);
  assert.match(text, /Supplies we will need:\n- Cable cover: 2\n- Eggshell paint: 1 gal/);
  assert.doesNotMatch(text, /exit sign: 1|LED exit sign/);
  assert.match(text, /Reply if you can help, and tell us which days work for you\./);
  assert.ok(text.endsWith("Made with SightWork \u00B7 https://sightwork.melanatedintech.com"));
  assert.doesNotMatch(text, /vercel\.app/);
});

test("the sample plan says it is a sample", () => {
  const p = plan();
  assert.match(volunteerCallText(p, volunteers(p), { date, sample: true })!, /Example plan with sample data, not a real run\./);
  assert.doesNotMatch(volunteerCallText(p, volunteers(p), { date, sample: false })!, /Example plan/);
});

test("steps that fix nothing known still get a plain opening, and one problem reads singular", () => {
  const p = plan({ workOrder: [{ order: 1, title: "Sweep up", detail: "", trade: "Volunteers", hours: [1, 1] }] });
  assert.match(volunteerCallText(p, volunteers(p), { date })!, /We have 1 job to get done here and could use your help\./);
  const q = plan({ workOrder: [{ order: 1, title: "Paint", detail: "", trade: "Volunteers", hours: [1, 1], fixes: [3] }] });
  assert.match(volunteerCallText(q, volunteers(q), { date })!, /We are fixing 1 problem here/);
});

test("a paid crew, or a crew with no steps, gets no call", () => {
  const p = plan();
  assert.equal(volunteerCallText(p, crewSummary(p.workOrder).rows[0]), null);
  assert.equal(volunteerCallText(p, { paid: false, steps: [], hours: null, hoursPartial: false }), null);
});

test("no hours means no hours or sharing line, and hours with gaps say at least without a sharing line", () => {
  const p = plan({ workOrder: [{ order: 1, title: "Paint", detail: "", trade: "Volunteers", fixes: [3] }] });
  const t = volunteerCallText(p, volunteers(p), { date })!;
  assert.doesNotMatch(t, / h of work|Shared between/);
  const q = plan({
    workOrder: [
      { order: 1, title: "Paint", detail: "", trade: "Volunteers", hours: [2, 3], fixes: [3] },
      { order: 2, title: "Sweep", detail: "", trade: "Volunteers" },
    ],
  });
  const u = volunteerCallText(q, volunteers(q), { date })!;
  assert.match(u, /at least 2–3 h of work in all/);
  assert.doesNotMatch(u, /Shared between/);
});

test("a long call is cut at a line under the limit and keeps the sign-off", () => {
  const many = Array.from({ length: 60 }, (_, i) => ({ order: i + 1, title: `Volunteer job number ${i + 1} with a long name`, detail: "", trade: "Volunteers", hours: [1, 1] as [number, number] }));
  const p = plan({ workOrder: many });
  const text = volunteerCallText(p, volunteers(p), { date, maxChars: 600 })!;
  assert.ok(text.length <= 600);
  assert.match(text, /Shortened for a text\./);
  assert.ok(text.endsWith("Made with SightWork \u00B7 https://sightwork.melanatedintech.com"));
  assert.doesNotMatch(text, /vercel\.app/);
});

test("title names the space, with a fallback", () => {
  assert.equal(volunteerCallTitle({ spaceName: " Fellowship  hall " }), "Volunteers needed: Fellowship hall");
  assert.equal(volunteerCallTitle({ spaceName: "  " }), "Volunteers needed: Work day");
});
