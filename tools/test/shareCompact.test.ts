/** Long plans go compact before the shared text is cut, so problems, steps and materials all fit. No network. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_SHARE_CHARS, planToText, shortIssueNote } from "@/lib/client/planText";
import type { Issue, WorkPlan } from "@/lib/types";
import { kitchenSample } from "@/lib/examples/kitchen";
import { EXAMPLES } from "@/lib/examples";
import { rankedIssues } from "@/lib/planExtras";

const DAY = new Date(2026, 9, 31, 14, 0);

test("kitchen example fits whole: every problem, step and material, no cut", () => {
  const text = planToText(kitchenSample, { date: DAY });
  assert.ok(text.length <= MAX_SHARE_CHARS, `length ${text.length}`);
  assert.ok(!text.includes("Shortened for a text."));
  for (const i of rankedIssues(kitchenSample)) assert.ok(text.includes(i.title), i.title);
  for (const s of kitchenSample.workOrder) assert.ok(text.includes(`${s.order}. ${s.title}`), s.title);
  for (const m of kitchenSample.materials) assert.ok(text.includes(m.item), m.item);
  assert.ok(text.endsWith("Made with SightWork \u00B7 sightwork.vercel.app"));
});

test("compact pass: one line per problem with a short note, Measure on site said once", () => {
  const text = planToText(kitchenSample, { date: DAY });
  assert.match(text, /^1\. Shutoff valve under the sink is leaking \(high, not mentioned\)$/m);
  assert.ok(!text.includes("   High priority."));
  assert.equal(text.match(/Measure on site/g)?.length, 1);
  assert.match(text, /^- Measure on site: .+ \u00B7 .+$/m);
  assert.match(text, /^Worth a closer look \(check in person\): .+ \u00B7 .+$/m);
  assert.match(text, /^Asked for: .{1,90}\u2026$/m);
});

test("plans that already fit keep the full form", () => {
  const full = planToText(kitchenSample, { date: DAY, maxChars: 99999 });
  assert.match(full, /^ {3}High priority\. Spotted on video, not mentioned on the walk\.$/m);
  assert.match(full, /^Start here: /m);
  assert.ok(!/^- Measure on site:/m.test(full));
  for (const e of EXAMPLES.filter((x) => x.id !== "kitchen" && x.id !== "sanctuary")) {
    const t = planToText(e.plan as WorkPlan, { date: DAY });
    assert.ok(!/\(high[,)]|\(medium[,)]|\(low[,)]/.test(t.split("Do the work")[0]), e.id);
  }
});

test("still too long after the compact pass: cut at a line, sign-off kept", () => {
  const text = planToText(kitchenSample, { date: DAY, maxChars: 600 });
  assert.ok(text.length <= 600);
  assert.ok(text.includes("Shortened for a text."));
  assert.ok(text.endsWith("Made with SightWork \u00B7 sightwork.vercel.app"));
  // The cut body is the compact one.
  assert.match(text, /\(high, not mentioned\)/);
});

test("shortIssueNote words", () => {
  const base = { severity: "medium", unmentioned: false, status: "mentioned" } as unknown as Issue;
  assert.equal(shortIssueNote(base, true), "medium");
  assert.equal(shortIssueNote({ ...base, unmentioned: true } as Issue, true), "medium, not mentioned");
  assert.equal(shortIssueNote({ ...base, status: "mentioned_not_seen" } as unknown as Issue, true), "medium, not seen on video, check in person");
  assert.equal(shortIssueNote({ ...base, unmentioned: true } as Issue, false), "medium");
  assert.equal(shortIssueNote(base, true, { verified: false } as never), "medium, no photo yet, check in person");
});
