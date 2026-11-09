/**
 * The examples on /start and the landing are what judges see first, so check they hold together:
 * every image exists and has the size the page reserves for it, every reference points at a real
 * frame / problem, samples are labeled and credited, and the general samples don't drift back to
 * church wording (the site is general; only the real sanctuary run is about a church).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { EXAMPLES, FEATURED_EXAMPLE, findExample } from "@/lib/examples";
import { FRAME_SIZES } from "@/lib/examples/frameSizes";
import { samplePlan } from "@/lib/mock/samplePlan";
import { planNoCost, planNoMeta } from "@/lib/mock/planNoMeta";
import type { WorkPlan } from "@/lib/types";
import { webpSize } from "./webp";

const PUBLIC = path.resolve("public");
const file = (url: string) => path.join(PUBLIC, url);

test("example ids are unique and the featured one is a general sample", () => {
  const ids = EXAMPLES.map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(FEATURED_EXAMPLE.id, "kitchen");
  assert.equal(findExample("nope"), FEATURED_EXAMPLE);
  assert.equal(findExample(null), FEATURED_EXAMPLE);
  for (const e of EXAMPLES) assert.equal(findExample(e.id), e);
});

test("FRAME_SIZES lists every bundled example image at its real size", () => {
  const onDisk = readdirSync(path.join(PUBLIC, "examples"), { recursive: true, encoding: "utf8" })
    .filter((f) => f.endsWith(".webp"))
    .map((f) => `/examples/${f.split(path.sep).join("/")}`)
    .sort();
  assert.deepEqual(Object.keys(FRAME_SIZES).sort(), onDisk, "regenerate src/lib/examples/frameSizes.ts");
  for (const [url, size] of Object.entries(FRAME_SIZES)) assert.deepEqual(webpSize(file(url)), size, url);
});

for (const e of EXAMPLES) {
  test(`example "${e.id}" holds together`, () => {
    const plan = e.plan;
    const frames = plan.frames ?? [];
    assert.ok(existsSync(file(e.thumb)), `thumb ${e.thumb}`);
    assert.ok(frames.length > 0, "has frames");
    frames.forEach((f, i) => {
      assert.equal(f.index, i, "frame index matches position");
      assert.ok(existsSync(file(f.url)), `frame ${f.url}`);
      assert.ok(f.width && f.height, `frame ${f.url} has a size (no layout shift)`);
    });
    if (plan.afterImageUrl) assert.ok(existsSync(file(plan.afterImageUrl)), plan.afterImageUrl);
    if (plan.heroFrameIndex !== undefined) assert.ok(frames[plan.heroFrameIndex], "hero frame exists");

    const ranks = new Set(plan.issues.map((i) => i.rank));
    assert.equal(ranks.size, plan.issues.length, "issue ranks unique");
    for (const issue of plan.issues) {
      assert.ok(frames[issue.frameIndex], `issue ${issue.rank} frame`);
      for (const p of issue.proofFrames ?? []) {
        assert.ok(frames[p.frameIndex], `issue ${issue.rank} proof frame`);
        if (p.box) {
          const [x0, y0, x1, y1] = p.box;
          assert.ok(0 <= x0 && x0 < x1 && x1 <= 1000 && 0 <= y0 && y0 < y1 && y1 <= 1000, `issue ${issue.rank} box in 0-1000`);
        }
      }
    }
    for (const step of plan.workOrder) for (const r of step.fixes ?? []) assert.ok(ranks.has(r), `step ${step.order} fixes ${r}`);
    for (const m of plan.materials) for (const r of m.forIssues ?? []) assert.ok(ranks.has(r), `material ${m.item} for ${r}`);
    for (const row of plan.saidVsSeen ?? []) {
      if (row.seen) assert.ok(frames[row.seen.frameIndex], "said-vs-saw frame");
      if (row.issueRank !== undefined) assert.ok(ranks.has(row.issueRank), "said-vs-saw issue");
    }

    if (e.kind === "sample") {
      assert.match(e.banner, /Not a SightWork run/, "sample banner says it isn't a run");
      assert.ok(e.credit && /^CC0/.test(e.credit.license) && /^https:\/\//.test(e.credit.url), "sample is credited CC0");
    } else {
      assert.match(e.banner, /Real SightWork run/);
      assert.equal(e.credit, undefined);
    }
  });
}

const CHURCH = /church|sanctuary|pulpit|pew|congregation/i;
const general: [string, WorkPlan][] = [
  ...EXAMPLES.filter((e) => e.kind === "sample").map((e) => [e.id, e.plan] as [string, WorkPlan]),
  ["mock full", samplePlan],
  ["mock nometa", planNoMeta],
  ["mock nocost", planNoCost],
];
for (const [name, plan] of general) {
  test(`"${name}" has no church wording (the site is general)`, () => {
    const text = JSON.stringify(plan);
    assert.doesNotMatch(text, CHURCH, text.match(CHURCH)?.[0]);
  });
}

test("card thumbnails on /start exist and stay small (under 100 KB each)", async () => {
  const { statSync } = await import("node:fs");
  for (const e of EXAMPLES) {
    const file = path.join(process.cwd(), "public", e.thumb);
    assert.ok(existsSync(file), `${e.id}: ${e.thumb} missing`);
    assert.ok(statSync(file).size < 100 * 1024, `${e.id}: ${e.thumb} is ${Math.round(statSync(file).size / 1024)} KB`);
  }
});

test("the featured sample shows the richer findings: every problem has a tier, where and what the photo shows, and a checklist area; closer-look finds point at real frames", async () => {
  const { areaFor } = await import("@/lib/checklist");
  const plan = FEATURED_EXAMPLE.plan;
  const tiers = new Set<string>();
  for (const issue of plan.issues) {
    assert.ok(issue.tier, `issue ${issue.rank} tier`);
    tiers.add(issue.tier!);
    assert.ok(issue.area && issue.area.length <= 80, `issue ${issue.rank} area`);
    assert.ok(issue.evidence && issue.evidence.length <= 160, `issue ${issue.rank} evidence`);
    assert.notEqual(areaFor(issue), "other", `issue ${issue.rank} checklist area`);
  }
  assert.deepEqual([...tiers].sort(), ["later", "soon", "urgent"]);
  const watch = plan.watch ?? [];
  assert.ok(watch.length >= 1, "has closer-look finds");
  for (const w of watch) {
    assert.ok(plan.frames![w.frameIndex], `watch ${w.title} frame`);
    assert.equal(w.frameTimeSec, plan.frames![w.frameIndex].tSec);
    assert.ok(w.confidence !== undefined && w.confidence < 0.5, `watch ${w.title} is below the keep threshold`);
    assert.notEqual(areaFor(w), "other", `watch ${w.title} checklist area`);
  }
});

test("every hand-written sample carries the richer findings, each problem and closer-look find in a known checklist area", async () => {
  const { areaFor } = await import("@/lib/checklist");
  const samples = EXAMPLES.filter((e) => e.kind === "sample");
  assert.ok(samples.length >= 4);
  for (const e of samples) {
    const plan = e.plan;
    for (const issue of plan.issues) {
      assert.ok(issue.tier, `${e.id} issue ${issue.rank} tier`);
      assert.ok(issue.area && issue.area.length <= 80, `${e.id} issue ${issue.rank} area`);
      assert.ok(issue.evidence && issue.evidence.length <= 160, `${e.id} issue ${issue.rank} evidence`);
      assert.notEqual(areaFor(issue), "other", `${e.id} issue ${issue.rank} checklist area`);
    }
    const watch = plan.watch ?? [];
    assert.ok(watch.length >= 1, `${e.id} has a closer-look find`);
    for (const w of watch) {
      assert.ok(plan.frames![w.frameIndex], `${e.id} watch ${w.title} frame`);
      assert.equal(w.frameTimeSec, plan.frames![w.frameIndex].tSec);
      assert.ok(w.confidence !== undefined && w.confidence < 0.5, `${e.id} watch ${w.title} below the keep threshold`);
      assert.ok(w.evidence && w.evidence.length <= 160, `${e.id} watch ${w.title} evidence`);
      assert.notEqual(areaFor(w), "other", `${e.id} watch ${w.title} checklist area`);
    }
  }
});
