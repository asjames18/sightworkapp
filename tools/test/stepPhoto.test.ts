/** The proof photo Send this step attaches (stepPhoto.ts) and the line the text gets for it. */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { WorkPlan } from "@/lib/types";
import { stepPhotoSource } from "@/lib/client/stepPhoto";
import { withPhotoLine } from "@/lib/client/proofPhoto";

const frames = [
  { index: 0, tSec: 1, url: "/f0.jpg" },
  { index: 1, tSec: 5, url: "/f1.jpg" },
  { index: 2, tSec: 9, url: "" },
];

function plan(over: Partial<WorkPlan> = {}): WorkPlan {
  return {
    spaceName: "Stage",
    inventory: [],
    frames,
    issues: [
      { rank: 1, title: "Only mentioned", severity: "low", frameIndex: 0, unmentioned: false, status: "mentioned_not_seen" },
      { rank: 2, title: "Loose cables", severity: "high", frameIndex: 0, unmentioned: true, proofFrames: [{ frameIndex: 1, box: [100, 100, 400, 400], boxSource: "model" }] },
      { rank: 3, title: "No frame", severity: "medium", frameIndex: 2, unmentioned: false },
      { rank: 4, title: "Scuffed rail", severity: "low", frameIndex: 0, unmentioned: false },
    ],
    workOrder: [],
    ...over,
  } as unknown as WorkPlan;
}

const step = (fixes?: number[]) => ({ order: 1, title: "Tape down cables", detail: "", fixes }) as WorkPlan["workOrder"][number];

test("picks the first fixed problem that was seen and has a frame", () => {
  const src = stepPhotoSource(plan(), step([1, 3, 2, 4]))!;
  assert.equal(src.rank, 2);
  assert.equal(src.title, "Loose cables");
  assert.equal(src.frame.url, "/f1.jpg");
  assert.deepEqual(src.box, [100, 100, 400, 400]);
  assert.equal(src.dashed, true); // no SAM masks in this plan, model box: a rough highlight
});

test("falls back to the problem's own frame with no outline", () => {
  const src = stepPhotoSource(plan(), step([4]))!;
  assert.equal(src.frame.url, "/f0.jpg");
  assert.equal(src.box, undefined);
});

test("null when the step fixes nothing with a photo", () => {
  assert.equal(stepPhotoSource(plan(), step()), null);
  assert.equal(stepPhotoSource(plan(), step([])), null);
  assert.equal(stepPhotoSource(plan(), step([1, 3, 9])), null);
  assert.equal(stepPhotoSource(plan({ frames: undefined }), step([2])), null);
});

test("a SAM outline is solid when masks ran", () => {
  const p = plan({ inventory: [{ label: "chairs", count: 3, method: "sam" }] } as unknown as Partial<WorkPlan>);
  (p.issues[1].proofFrames![0] as { boxSource?: string }).boxSource = "sam";
  assert.equal(stepPhotoSource(p, step([2]))!.dashed, false);
});

test("photo line names the problem the step's photo shows, before the sign-off", () => {
  const text = "Step 1: Tape down cables\nWho: crew\n\nMade with SightWork";
  assert.equal(withPhotoLine(text, true, "problem #2"), "Step 1: Tape down cables\nWho: crew\nPhoto attached, with problem #2 outlined.\n\nMade with SightWork");
  assert.match(withPhotoLine(text, false, "problem #4"), /Photo attached, showing problem #4\.\n\nMade with/);
  // The problem's own wording is unchanged.
  assert.match(withPhotoLine(text, true), /Photo attached, with the problem outlined\./);
  assert.match(withPhotoLine(text, false), /Photo attached\.\n\nMade/);
});
