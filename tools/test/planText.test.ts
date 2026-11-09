/** Plan as plain text for "Send to your team", and the share-or-copy fallback. No network. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_SHARE_CHARS, canShareFiles, planToText, sharePlanText, type ShareNavigator } from "@/lib/client/planText";
import { COST_LABEL, type WorkPlan } from "@/lib/types";

function plan(extra: Partial<WorkPlan> = {}): WorkPlan {
  return {
    spaceName: "Main sanctuary  stage",
    generatedFrom: "Walkthrough video, 12 frames, 60 s, narrated",
    inventory: [],
    issues: [
      { rank: 2, title: "Loose carpet seam", detail: "", severity: "medium", frameIndex: 1, frameTimeSec: 5, unmentioned: false },
      { rank: 1, title: "Cable across the steps", detail: "", severity: "high", frameIndex: 0, frameTimeSec: 2, unmentioned: true },
    ],
    materials: [{ item: "Cable cover", qty: "2" }],
    workOrder: [
      { order: 2, title: "Re-tape the seam", detail: "" },
      { order: 1, title: "Cover the cable", detail: "", trade: "Volunteer", hours: [0.5, 1] },
    ],
    afterImageUrl: null,
    transcript: "[0.0] Check the stage.",
    transcriptSummary: "Get the stage ready for Sunday.",
    ...extra,
  };
}

const DAY = new Date(2026, 9, 30, 17, 0);
const COST = { low: 120, high: 340, currency: "USD" as const, label: COST_LABEL, region: "Sebring, FL", laborBasis: "volunteer" as const, assumptions: [] };

test("header: space, city and state, date, and how many problems", () => {
  const t = planToText(plan({ costRange: COST }), { date: DAY });
  assert.match(t, /^Work plan: Main sanctuary stage\nSebring, FL · Oct 30, 2026\n2 problems, worst first\. 1 of 2 never mentioned on the walk, caught on video\.\n/);
  assert.match(t, /Asked for: Get the stage ready for Sunday\./);
  // No region: just the date.
  assert.match(planToText(plan(), { date: DAY }), /^Work plan: Main sanctuary stage\nOct 30, 2026\n2 problems, worst first\. 1 of 2 never mentioned/);
  assert.match(planToText(plan({ issues: [plan().issues[1]] }), { date: DAY }), /\n1 problem\. Never mentioned on the walk, caught on video\.\n/);
});

test("problems in plain words, worst first; steps in order; materials", () => {
  const t = planToText(plan(), { date: DAY });
  assert.match(t, /\n1\. Cable across the steps\n   High priority\. Spotted on video, not mentioned on the walk\.\n2\. Loose carpet seam\n   Medium priority\. Mentioned on the walk and seen on video\.\n/);
  assert.doesNotMatch(t, /\[|\]/, "no bracket tags");
  assert.match(t, /Do the work in this order:\n1\. Cover the cable \(Volunteer, 0\.5-1 h\)\n2\. Re-tape the seam\n/);
  assert.match(t, /Materials:\n- Cable cover: 2\n/);
  assert.doesNotMatch(t, /Cost:/);
  assert.doesNotMatch(t, /Example plan/);
});

test("ends with where it came from, never a dead-end pointer to photos", () => {
  const t = planToText(plan(), { date: DAY });
  assert.match(t, /\n\nMade with SightWork · sightwork\.vercel\.app$/);
  assert.doesNotMatch(t, /Proof photos are in the full plan/);
  assert.match(planToText(plan(), { date: DAY, pdfAttached: true }), /\n\nFull plan with proof photos in the attached PDF\.$/);
});

test("no narration: says seen on camera, no mention wording, no ask line", () => {
  const t = planToText(plan({ transcript: null, transcriptTurns: [] }));
  assert.match(t, /High priority\. Seen on camera\./);
  assert.doesNotMatch(t, /mentioned/);
  assert.doesNotMatch(t, /Asked for/);
});

test("cost line carries the range, the city and state, and the not-a-quote label", () => {
  const t = planToText(plan({ costRange: COST }));
  assert.match(t, /\n\nCost: \$120-\$340 for Sebring, FL\. Rough estimate, not a quote\.\n/);
});

test("an example plan says it is sample data, and an empty plan says so", () => {
  const t = planToText(plan({ issues: [], workOrder: [], materials: [], meta: { isExample: true } }));
  assert.match(t, /No problems found\.\nExample plan with sample data, not a real run\./);
  assert.match(t, /Nothing stood out/);
  assert.doesNotMatch(t, /Do the work/);
  assert.doesNotMatch(t, /Materials:/);
});

test("fits a text message by default; long plans are cut at a line and keep the sign-off", () => {
  const many = Array.from({ length: 200 }, (_, i) => ({ order: i + 1, title: `Step number ${i + 1} with some words`, detail: "" }));
  const t = planToText(plan({ workOrder: many }));
  assert.ok(t.length <= MAX_SHARE_CHARS && MAX_SHARE_CHARS <= 1600, `length ${t.length}`);
  assert.match(t, /\n\.\.\.\nShortened for a text\.\n\nMade with SightWork · sightwork\.vercel\.app$/);
  assert.match(t.split("\n...\n")[0], /\n\d+\. Step number \d+ with some words$/, "cut at a whole line");
  const withPdf = planToText(plan({ workOrder: many }), { maxChars: 800, pdfAttached: true });
  assert.ok(withPdf.length <= 800);
  assert.match(withPdf, /The PDF has everything\.\n\nFull plan with proof photos in the attached PDF\.$/);
});

test("a real-sized plan stays short enough for a text", () => {
  const t = planToText(plan({ costRange: COST }));
  // Room for the never-mentioned headline in the header; still well under MAX_SHARE_CHARS.
  assert.ok(t.length < 760, `length ${t.length}`);
});

test("share: uses the share sheet when preferred and available", async () => {
  let shared = 0;
  const nav: ShareNavigator = { share: async () => { shared++; }, clipboard: { writeText: async () => assert.fail("no copy") } };
  assert.equal(await sharePlanText("t", "x", nav, true), "shared");
  assert.equal(shared, 1);
});

test("share: a dismissed share sheet is cancelled and does not copy", async () => {
  const abort = Object.assign(new Error("dismissed"), { name: "AbortError" });
  const nav: ShareNavigator = { share: async () => { throw abort; }, clipboard: { writeText: async () => assert.fail("no copy") } };
  assert.equal(await sharePlanText("t", "x", nav, true), "cancelled");
});

test("share: falls back to the clipboard when share is refused, unpreferred, or missing", async () => {
  const copied: string[] = [];
  const clipboard = { writeText: async (s: string) => { copied.push(s); } };
  assert.equal(await sharePlanText("t", "a", { share: async () => { throw new Error("NotAllowed"); }, clipboard }, true), "copied");
  assert.equal(await sharePlanText("t", "b", { share: async () => assert.fail("not preferred"), clipboard }, false), "copied");
  assert.equal(await sharePlanText("t", "c", { canShare: () => false, share: async () => assert.fail("cannot"), clipboard }, true), "copied");
  assert.deepEqual(copied, ["a", "b", "c"]);
});

test("share: fails cleanly with no share sheet and no clipboard, or a rejected copy", async () => {
  assert.equal(await sharePlanText("t", "x", {}, true), "failed");
  assert.equal(await sharePlanText("t", "x", { clipboard: { writeText: async () => { throw new Error("denied"); } } }, false), "failed");
});

test("the sample flag from the screen overrides meta, both ways", () => {
  assert.match(planToText(plan(), { sample: true }), /Example plan with sample data/);
  assert.doesNotMatch(planToText(plan({ meta: { isExample: true } }), { sample: false }), /Example plan/);
});

test("share: attaches the PDF with its own text when the sheet takes files", async () => {
  const pdf = new File([new Uint8Array([37, 80, 68, 70])], "sightwork-plan-2026-10-30.pdf", { type: "application/pdf" });
  const seen: { text?: string; files?: File[] }[] = [];
  const nav: ShareNavigator = {
    canShare: (d) => !d.files || d.files[0]?.type === "application/pdf",
    share: async (d) => { seen.push(d); },
  };
  assert.equal(canShareFiles(nav, [pdf]), true);
  assert.equal(await sharePlanText("t", "plain", nav, true, { files: [pdf], text: "with pdf" }), "shared");
  assert.deepEqual(seen.map((d) => [d.text, d.files?.length ?? 0]), [["with pdf", 1]]);
});

test("share: no file support sends the plain text; a refused file share falls back to text", async () => {
  const pdf = new File([new Uint8Array([1])], "p.pdf", { type: "application/pdf" });
  const sent: (string | undefined)[] = [];
  const noFiles: ShareNavigator = { canShare: (d) => !d.files, share: async (d) => { sent.push(d.text); } };
  assert.equal(canShareFiles(noFiles, [pdf]), false);
  assert.equal(await sharePlanText("t", "plain", noFiles, true, { files: [pdf], text: "with pdf" }), "shared");
  const refusesFiles: ShareNavigator = {
    canShare: () => true,
    share: async (d) => { if (d.files) throw Object.assign(new Error("no"), { name: "NotAllowedError" }); sent.push(d.text); },
  };
  assert.equal(await sharePlanText("t", "plain", refusesFiles, true, { files: [pdf], text: "with pdf" }), "shared");
  assert.deepEqual(sent, ["plain", "plain"]);
  assert.equal(canShareFiles({ share: async () => {}, canShare: () => { throw new TypeError("bad"); } }, [pdf]), false);
});
