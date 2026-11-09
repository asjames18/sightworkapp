import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BEFORE_AFTER_GAP,
  BEFORE_AFTER_MAX_SIDE,
  beforeAfterCaptionFor,
  beforeAfterLayout,
  beforeAfterName,
  beforeAfterShareText,
  beforeAfterShareTitle,
  coverCrop,
  getBeforeAfterPhoto,
} from "../../src/lib/client/beforeAfterPhoto";
import { SHARE_SIGNOFF } from "../../src/lib/client/planText";

test("beforeAfterLayout: wide frames sit side by side, within the size cap", () => {
  const l = beforeAfterLayout(1920, 1080)!;
  assert.equal(l.direction, "row");
  assert.ok(Math.max(l.width, l.height) <= BEFORE_AFTER_MAX_SIDE);
  assert.equal(l.before.w, l.after.w);
  assert.equal(l.before.h, l.after.h);
  assert.equal(l.after.x, l.before.w + BEFORE_AFTER_GAP);
  assert.equal(l.after.y, 0);
  assert.equal(l.width, l.before.w * 2 + BEFORE_AFTER_GAP);
  assert.equal(l.caption.y, l.before.h);
  assert.equal(l.height, l.before.h + l.caption.h);
  assert.ok(l.caption.h >= 28);
});

test("beforeAfterLayout: tall frames stack, so neither panel is a sliver", () => {
  const l = beforeAfterLayout(1080, 1920)!;
  assert.equal(l.direction, "column");
  assert.ok(Math.max(l.width, l.height) <= BEFORE_AFTER_MAX_SIDE);
  assert.equal(l.after.x, 0);
  assert.equal(l.after.y, l.before.h + BEFORE_AFTER_GAP);
  assert.equal(l.width, l.before.w);
  assert.equal(l.caption.y, l.before.h * 2 + BEFORE_AFTER_GAP);
});

test("beforeAfterLayout: small frames are not scaled up; missing sizes give null", () => {
  const l = beforeAfterLayout(320, 240)!;
  assert.equal(l.before.w, 320);
  assert.equal(l.before.h, 240);
  assert.equal(beforeAfterLayout(0, 100), null);
  assert.equal(beforeAfterLayout(100, Number.NaN), null);
});

test("coverCrop: crops the long side to the panel's shape, centered", () => {
  assert.deepEqual(coverCrop(2000, 1000, { w: 400, h: 300 }), { x: (2000 - 1000 * (4 / 3)) / 2, y: 0, w: 1000 * (4 / 3), h: 1000 });
  const tall = coverCrop(1000, 2000, { w: 400, h: 300 });
  assert.equal(tall.x, 0);
  assert.equal(tall.w, 1000);
  assert.equal(tall.h, 750);
  assert.equal(tall.y, 625);
  assert.deepEqual(coverCrop(800, 600, { w: 400, h: 300 }), { x: 0, y: 0, w: 800, h: 600 });
});

test("beforeAfterName and title: place in the name when there is one", () => {
  assert.equal(beforeAfterName("Sanctuary stage"), "sightwork-before-after-sanctuary-stage.jpg");
  assert.equal(beforeAfterName("Café & kitchen"), "sightwork-before-after-cafe-kitchen.jpg");
  assert.equal(beforeAfterName(""), "sightwork-before-after.jpg");
  assert.equal(beforeAfterName(undefined), "sightwork-before-after.jpg");
  assert.ok(!beforeAfterName("a".repeat(39) + " b").includes("-.jpg"));
  assert.equal(beforeAfterShareTitle(" Sanctuary stage "), "Before and after: Sanctuary stage");
  assert.equal(beforeAfterShareTitle(null), "Before and after");
});

test("beforeAfterCaptionFor: says where the AI concept is and carries the label", () => {
  assert.equal(beforeAfterCaptionFor("row", "AI concept, not a render"), "After (right): AI concept, not a render · SightWork");
  assert.equal(beforeAfterCaptionFor("column", "AI concept, not a render."), "After (bottom): AI concept, not a render · SightWork");
  assert.equal(beforeAfterCaptionFor("row", "  "), "After (right): AI concept · SightWork");
});

test("beforeAfterShareText: names the place, says the after is a concept, marks examples, signs off", () => {
  const t = beforeAfterShareText("Sanctuary stage", "AI concept, not a render");
  assert.equal(
    t,
    [
      "Before and after for Sanctuary stage.",
      "Before: a frame from the walkthrough video.",
      "After: AI concept, not a render. It shows what the space could look like once the work is done.",
      "",
      SHARE_SIGNOFF,
    ].join("\n"),
  );
  assert.ok(beforeAfterShareText(null, "AI concept").startsWith("Before and after.\n"));
  assert.ok(beforeAfterShareText("Stage", "AI concept", { sample: true }).includes("From SightWork's example plan."));
  assert.ok(!t.includes("example"));
});

test("getBeforeAfterPhoto: nothing to draw without both pictures (and no DOM here)", async () => {
  assert.equal(await getBeforeAfterPhoto("", "/a.webp", { label: "x" }), null);
  assert.equal(await getBeforeAfterPhoto("/b.webp", "", { label: "x" }), null);
  assert.equal(await getBeforeAfterPhoto("/b.webp", "/a.webp", { label: "x" }), null);
});
