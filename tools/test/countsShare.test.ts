/** The shared text carries a short counts line saying how the counts were made. No network. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { countsShareLine, MAX_SHARE_COUNTS } from "@/lib/client/countMethod";
import { MAX_SHARE_CHARS, planToText } from "@/lib/client/planText";
import type { InventoryItem, WorkPlan } from "@/lib/types";
import sanctuary from "@/lib/examples/sanctuary-run.json";
import { EXAMPLES } from "@/lib/examples/index";

const DAY = new Date(2026, 9, 31, 14, 0);
const item = (label: string, count: number, extra: Partial<InventoryItem> = {}): InventoryItem => ({ label, count, confidence: 0.9, ...extra });

test("SAM counts say so, a disagreeing count shows its range, low confidence is flagged", () => {
  const line = countsShareLine(
    [item("chairs", 212, { method: "sam" }), item("lights", 15, { method: "sam+model", range: [14, 16] }), item("exit signs", 4, { method: "sam", confidence: 0.3 })],
    true,
  );
  assert.equal(line, "What's there (counted from SAM 3.1 outlines, approximate): 212 chairs, 14-16 lights, 4 exit signs (check by hand).");
});

test("without outlines the line never claims SAM and drops SAM ranges", () => {
  const line = countsShareLine([item("chairs", 200, { method: "sam", range: [180, 220] })], false);
  assert.equal(line, "What's there (estimated from the frames, approximate): 200 chairs.");
});

test("long lists are cut with a count of the rest; no counts means no line", () => {
  const many = Array.from({ length: MAX_SHARE_COUNTS + 2 }, (_, n) => item(`thing ${n}`, n, { method: "model" }));
  assert.match(countsShareLine(many, false) ?? "", /, and 2 more\.$/);
  assert.equal(countsShareLine([], true), null);
  assert.equal(countsShareLine([item(" ", 3)], true), null);
});

test("the sanctuary example's shared text has the counts line and stays under the cap", () => {
  const t = planToText(sanctuary as unknown as WorkPlan, { date: DAY });
  assert.match(t, /\nWhat's there \(counted from SAM 3\.1 outlines, approximate\): /);
  assert.ok(t.length <= MAX_SHARE_CHARS, `length ${t.length}`);
});

test("labels read as words in a sentence, acronyms stay as written", () => {
  assert.equal(countsShareLine([item("Padded chairs", 64, { method: "model" }), item("AV racks", 2, { method: "model" })], false), "What's there (estimated from the frames, approximate): 64 padded chairs, 2 AV racks.");
});

test("every example's shared text stays under the cap and is not shortened", () => {
  assert.ok(EXAMPLES.length > 0);
  for (const ex of EXAMPLES) {
    const t = planToText(ex.plan, { date: DAY });
    assert.ok(t.length <= MAX_SHARE_CHARS, `length ${t.length}`);
    // The kitchen sample was already cut before counts were added; the real sanctuary run is a long narrated plan, so its
    // text takes the compact form and is cut after the cost line, as any long real plan is.
    if (ex.id !== "kitchen" && ex.id !== "sanctuary") assert.doesNotMatch(t, /Shortened/);
  }
});

test("the real sanctuary run's shared text keeps every problem, every step and the cost before it is cut", () => {
  const t = planToText(EXAMPLES.find((e) => e.id === "sanctuary")!.plan, { date: DAY });
  assert.ok(t.length <= MAX_SHARE_CHARS, `length ${t.length}`);
  assert.match(t, /^6\. Unsecured equipment and tangled cords on stage \(medium\)$/m);
  assert.match(t, /^6\. Organize and secure stage equipment /m);
  assert.match(t, /^Cost: \$260-\$460 for Sebring, FL\./m);
  assert.match(t, /Made with SightWork \u00B7 sightwork\.vercel\.app$/);
});

test("when the text runs long the counts line is dropped before anything is cut", () => {
  const plan = sanctuary as unknown as WorkPlan;
  const full = planToText(plan, { date: DAY, maxChars: 100000 });
  const line = full.split("\n").find((l) => l.startsWith("What's there"));
  assert.ok(line);
  const tight = planToText(plan, { date: DAY, maxChars: full.length - 5 });
  assert.doesNotMatch(tight, /What's there/);
  assert.doesNotMatch(tight, /Shortened/);
  assert.equal(tight, full.replace(`\n\n${line}`, ""));
});
