import { test } from "node:test";
import assert from "node:assert/strict";
import { boxToPixels, getProofPhoto, proofPhotoName, proofPhotoSize, withPhotoLine } from "../../src/lib/client/proofPhoto";

test("proofPhotoName: rank and a short slug of the title", () => {
  assert.equal(proofPhotoName(2, "Loose cables & extension cords across stage floor"), "sightwork-problem-2-loose-cables-extension-cords-across.jpg");
  assert.equal(proofPhotoName(1, "Café wall"), "sightwork-problem-1-cafe-wall.jpg");
  assert.equal(proofPhotoName(3, "!!!"), "sightwork-problem-3.jpg");
  assert.ok(!proofPhotoName(4, "a".repeat(39) + " b").includes("-.jpg"));
});

test("proofPhotoSize: keeps small images, scales the long side down to the cap", () => {
  assert.deepEqual(proofPhotoSize(648, 486), { width: 648, height: 486 });
  assert.deepEqual(proofPhotoSize(1920, 1080), { width: 1280, height: 720 });
  assert.deepEqual(proofPhotoSize(1080, 1920), { width: 720, height: 1280 });
  assert.deepEqual(proofPhotoSize(0, 100), { width: 0, height: 0 });
});

test("boxToPixels: normalized box to pixels, clamped and ordered", () => {
  assert.deepEqual(boxToPixels([100, 200, 600, 700], 1000, 500), { x: 100, y: 100, w: 500, h: 250, line: 3 });
  const flipped = boxToPixels([600, 700, 100, 200], 1000, 500)!;
  assert.equal(flipped.x, 100);
  assert.equal(flipped.w, 500);
  const out = boxToPixels([-50, 900, 1200, 1100], 1280, 720)!;
  assert.equal(out.x, 0);
  assert.equal(out.w, 1280);
  assert.equal(out.h, 72);
  assert.equal(out.line, Math.round(720 / 160));
  assert.equal(boxToPixels([500, 500, 500, 900], 1000, 1000), null);
});

test("withPhotoLine: the photo line sits just before the sign-off", () => {
  const text = "Problem #1 · Fix now\nLoose cables\n\nMade with SightWork · sightwork.vercel.app";
  assert.equal(withPhotoLine(text, true), "Problem #1 · Fix now\nLoose cables\nPhoto attached, with the problem outlined.\n\nMade with SightWork · sightwork.vercel.app");
  assert.equal(withPhotoLine("Just one line", false), "Just one line\nPhoto attached.");
});

test("getProofPhoto: no frame or no browser gives null, so the problem goes as text", async () => {
  assert.equal(await getProofPhoto(undefined, undefined, { rank: 1, title: "x", dashed: false }), null);
  assert.equal(await getProofPhoto({ index: 0, tSec: 1, url: "/examples/kitchen/f0.webp" }, [0, 0, 500, 500], { rank: 1, title: "x", dashed: false }), null);
});
