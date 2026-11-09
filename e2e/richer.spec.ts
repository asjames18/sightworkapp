import fs from "node:fs";
import path from "node:path";
import { test, expect, expectNoAxeViolations, expectNoSideScroll, WALKTHROUGH } from "./helpers";

/**
 * Richer findings (Oct 30 plan, items 2, 3, 5, 6, 7), UI side. No model calls: /api/transcribe and /api/plan are
 * answered by a stub in the browser with the real Oct 30 sanctuary plan plus the new optional fields. Set
 * RICHER_SHOT_DIR to save screenshots.
 */

const sanctuary = JSON.parse(fs.readFileSync(path.join(__dirname, "../src/lib/examples/sanctuary-run.json"), "utf8"));
const SHOTS = process.env.RICHER_SHOT_DIR;

/** The Oct 30 sanctuary plan with every new field the server may send. */
function richerPlan() {
  const p = structuredClone(sanctuary);
  const extra: Record<number, Record<string, unknown>> = {
    1: { tier: "urgent", checklistKey: "trip_cable", area: "Stage, front right by the keyboard", evidence: "Black and grey cables coiled loose on the stage floor" },
    2: { tier: "urgent", checklistKey: "exposed_wiring", area: "Stage, centre right", evidence: "A power strip lying on the floor with cords plugged in" },
    3: { tier: "soon", checklistKey: "steps", area: "Both stage steps", evidence: "Two carpeted steps up to the stage, no rail on either side" },
    4: { tier: "later", checklistKey: "flooring", area: "Stage deck", evidence: "Dust, scuffs and a tissue box on the stage floor" },
  };
  for (const i of p.issues) Object.assign(i, extra[i.rank]);
  p.issues[0].proofFrames[0].boxSource = "sam";
  p.watch = [
    { title: "Exit sign may be unlit", detail: "The sign over the side door looks dark in one frame. Check it with the lights off.", confidence: 0.45, frameIndex: 2, frameTimeSec: p.frames[2].tSec, area: "Side door, left wall", checklistKey: "exit_sign", evidence: "A dark exit sign above the left door" },
    { title: "Possible carpet seam lifting", detail: "A light line across the aisle carpet could be a lifted seam.", confidence: 0.38, frameIndex: 1, frameTimeSec: p.frames[1].tSec, area: "Centre aisle", checklistKey: "flooring" },
  ];
  p.costRange = {
    low: 1180.5,
    high: 2643.2,
    currency: "USD",
    label: "Rough estimate, not a quote",
    region: "Sebring, FL",
    laborBasis: "mixed",
    assumptions: ["Mid-grade materials", "15% contingency on every line"],
    byIssue: [
      { rank: 1, low: 240.2, high: 560.4 },
      { rank: 2, low: 240.1, high: 560.4 },
      { rank: 3, low: 520.1, high: 1120.3 },
      { rank: 4, low: 180.1, high: 402.1 },
    ],
    byStep: [
      { order: 1, low: 480.3, high: 1120.8 },
      { order: 2, low: 520.1, high: 1120.3 },
      { order: 3, low: 60, high: 140 },
      { order: 4, low: 120.1, high: 262.1 },
    ],
  };
  p.review = {
    ran: true,
    source: "model",
    items: [
      { problemId: "1", verified: false, verdict: "partly", supportedScope: "cable on the stage only, not down the steps", reason: "Photo A shows cables on the stage deck; the steps are clear." },
      { problemId: "2", verified: true, verdict: "verified", reason: "Photo B shows the power strip on the floor with cords in it." },
      { problemId: "3", verified: true, verdict: "verified", reason: "Photo C shows both steps with no rail." },
      { problemId: "4", verified: true, verdict: "verified", reason: "Photo B shows debris and scuffs on the deck." },
    ],
  };
  return p;
}

async function stubPlan(page: import("@playwright/test").Page, plan: unknown) {
  const sent: { spaceType?: string; spaceName?: string; frames: number }[] = [];
  await page.route("**/api/transcribe", (r) => r.fulfill({ json: { transcript: "", transcriptTurns: [] } }));
  await page.route("**/api/plan", (r) => {
    const body = JSON.parse(r.request().postData() ?? "{}");
    sent.push({ spaceType: body.spaceType, spaceName: body.spaceName, frames: body.frames?.length ?? 0 });
    return r.fulfill({ contentType: "application/x-ndjson", body: [{ state: "running", step: "planning" }, { state: "done", plan }].map((l) => JSON.stringify(l)).join("\n") + "\n" });
  });
  await page.addInitScript(() => {
    window.localStorage.setItem("sightwork:test-code", "stub-code");
    window.localStorage.setItem("sightwork:location", JSON.stringify({ city: "Sebring", state: "FL" }));
  });
  return sent;
}

async function shot(page: import("@playwright/test").Page, name: string, locator?: import("@playwright/test").Locator) {
  if (!SHOTS) return;
  await page.evaluate(() => document.querySelectorAll("img").forEach((i) => (i.loading = "eager")));
  await page.waitForTimeout(600);
  // The sticky section chips would sit on top of element shots; hide them for the picture only.
  const hide = Boolean(locator);
  await page.evaluate((h) => document.querySelectorAll<HTMLElement>('nav[aria-label="Plan sections"], header').forEach((n) => (n.style.visibility = h ? "hidden" : "")), hide);
  const w = page.viewportSize()?.width ?? 0;
  const file = path.join(SHOTS, `${name}-${w}.png`);
  if (locator) await locator.screenshot({ path: file });
  else await page.screenshot({ path: file, fullPage: true });
  if (hide) await page.evaluate(() => document.querySelectorAll<HTMLElement>('nav[aria-label="Plan sections"], header').forEach((n) => (n.style.visibility = "")));
}

test("space picker on the video card: the pick and name go with the run, and denser frames are sent", async ({ page }) => {
  const sent = await stubPlan(page, richerPlan());
  await page.goto("/start?runner=api");
  await page.getByTestId("choose-video-input").setInputFiles(WALKTHROUGH);
  const card = page.getByRole("group", { name: "Your walkthrough" });
  await card.getByLabel("Type", { exact: true }).selectOption("sanctuary");
  await card.getByLabel("Name", { exact: true }).fill("Main sanctuary");
  await expectNoAxeViolations(page, "video card with the space picker");
  await expectNoSideScroll(page);
  await shot(page, "video-card-space-picker", card);
  await page.getByRole("button", { name: "Make my work plan" }).click();
  await expect(page.getByRole("heading", { name: "Problems, worst first" })).toBeVisible({ timeout: 30_000 });
  expect(sent).toHaveLength(1);
  expect(sent[0].spaceType).toBe("church sanctuary");
  expect(sent[0].spaceName).toBe("Main sanctuary");
  // A 6 s take sent 3 frames on the 2 s ticks; dense windows send at least 5.
  expect(sent[0].frames).toBeGreaterThanOrEqual(5);
  expect(sent[0].frames).toBeLessThanOrEqual(30);
  // Remembered on this device for the next video.
  await page.reload();
  await page.getByTestId("choose-video-input").setInputFiles(WALKTHROUGH);
  await expect(page.getByLabel("Type", { exact: true })).toHaveValue("sanctuary");
});

test("richer plan: tiers, where and what, partly backed, SAM outline, cost shares that add up, closer-look list, checklist", async ({ page }) => {
  await stubPlan(page, richerPlan());
  await page.goto("/start?runner=api");
  await page.getByTestId("choose-video-input").setInputFiles(WALKTHROUGH);
  await page.getByRole("button", { name: "Make my work plan" }).click();
  const problems = page.locator("#problems");
  await expect(problems.getByRole("heading", { level: 3, name: /^Fix now/ })).toBeVisible({ timeout: 30_000 });
  await expect(problems.getByRole("heading", { level: 3, name: /^Fix soon/ })).toBeVisible();
  await expect(problems.getByRole("heading", { level: 3, name: /^Can wait/ })).toBeVisible();
  await expect(page.getByText("Reviewed by a separate check: 3 of 4 problems backed by a photo, 1 partly.")).toBeVisible();

  const card1 = problems.getByRole("listitem").filter({ hasText: "Loose cables and extension cords" });
  await expect(card1.getByText("Partly backed", { exact: true })).toBeVisible();
  await expect(card1.getByText(/the photos show cable on the stage only, not down the steps/)).toBeVisible();
  await expect(card1.getByText("Stage, front right by the keyboard")).toBeVisible();
  await expect(card1.getByText("Outlined by SAM 3.1").first()).toBeVisible();
  await expect(page.getByText("Unverified", { exact: true })).toHaveCount(0);

  // Displayed shares add up exactly to the displayed total.
  const dollars = (s: string) => s.match(/\$?([\d,]+)/g)!.map((x) => Number(x.replace(/[$,]/g, "")));
  const issueShares = await page.getByTestId("issue-cost").allTextContents();
  expect(issueShares).toHaveLength(4);
  const stepShares = await page.getByTestId("step-cost").allTextContents();
  expect(stepShares).toHaveLength(4);
  const sumOf = (list: string[], k: 0 | 1) => list.map((t) => dollars(t.replace("Share of cost", ""))[k]).reduce((a, b) => a + b, 0);
  expect(sumOf(issueShares, 0)).toBe(1181);
  expect(sumOf(issueShares, 1)).toBe(2643);
  expect(sumOf(stepShares, 0)).toBe(1181);
  expect(sumOf(stepShares, 1)).toBe(2643);
  await expect(page.getByText("$1,181 – $2,643")).toBeVisible();
  await expect(page.getByTestId("cost-shares-note")).toBeVisible();

  // Closer look: collapsed until opened.
  const watch = page.getByTestId("watch-list");
  await expect(watch).toBeVisible();
  await expect(watch.getByText("Exit sign may be unlit")).toBeHidden();
  await shot(page, "problems-tiers", problems);
  await watch.getByText("Worth a closer look").click();
  await expect(watch.getByText("Exit sign may be unlit")).toBeVisible();
  await expect(watch.getByText("45% sure")).toBeVisible();
  await shot(page, "closer-look-open", watch);

  const checklist = page.getByTestId("checklist");
  await expect(checklist.getByRole("heading", { name: "What SightWork checked" })).toBeVisible();
  await expect(checklist.getByRole("listitem").filter({ hasText: "AV and cables" })).toContainText("1 problem");
  await expect(checklist.getByRole("listitem").filter({ hasText: "Exits and fire safety" })).toContainText("1 problem · 1 to check");
  await expect(checklist.getByRole("list", { name: "Areas with nothing flagged" }).getByRole("listitem").filter({ hasText: "Heating and vents" })).toBeVisible();
  await expect(checklist.getByRole("list", { name: "Areas with nothing flagged" }).getByRole("listitem").filter({ hasText: "Plumbing and water" })).toBeVisible();
  await expect(checklist.getByRole("list", { name: "Areas with findings" }).getByRole("listitem")).toHaveCount(4);
  await shot(page, "checklist", checklist);
  await shot(page, "steps-with-costs", page.locator("#steps"));

  await expectNoSideScroll(page);
  await expectNoAxeViolations(page, "richer plan with the closer-look list open");
  await shot(page, "plan-richer-full");
});

test("thin plan: one problem, no tier headings, a coverage note that says why, closer-look list still there", async ({ page }) => {
  const p = richerPlan();
  p.issues = [p.issues[0]];
  p.issues[0].rank = 1;
  p.saidVsSeen = [];
  p.workOrder = [{ ...p.workOrder[0], fixes: [1] }];
  p.materials = [];
  p.costRange = null;
  p.review = { ran: true, source: "model", items: [p.review.items[0]] };
  p.coverageNote = "Only the stage was filmed; the seating and back wall were not in the frames.";
  await stubPlan(page, p);
  await page.goto("/start?runner=api");
  await page.getByTestId("choose-video-input").setInputFiles(WALKTHROUGH);
  await page.getByRole("button", { name: "Make my work plan" }).click();
  const problems = page.locator("#problems");
  await expect(problems.getByTestId("coverage-note")).toContainText("Why only one problem: Only the stage was filmed", { timeout: 30_000 });
  await expect(problems.getByRole("heading", { level: 3, name: /^Fix now/ })).toHaveCount(0);
  const watch = problems.getByTestId("watch-list");
  await expect(watch).toBeVisible();
  await expect(page.getByTestId("issue-cost")).toHaveCount(0);
  // Save PDF: the collapsed list opens for printing and closes again after.
  await expect(watch).not.toHaveAttribute("open", "");
  await page.evaluate(() => window.dispatchEvent(new Event("beforeprint")));
  await expect(watch).toHaveAttribute("open", "");
  await page.evaluate(() => window.dispatchEvent(new Event("afterprint")));
  await expect(watch).not.toHaveAttribute("open", "");
  await expectNoAxeViolations(page, "thin plan with coverage note");
  await shot(page, "problems-thin", problems);
});

test("no problems, only closer-look finds: the empty state and the list together", async ({ page }) => {
  const p = richerPlan();
  p.issues = [];
  p.saidVsSeen = [];
  p.workOrder = [];
  p.materials = [];
  p.costRange = null;
  p.review = { ran: true, source: "model", items: [] };
  p.coverageNote = "The frames were dark and only showed the centre aisle.";
  await stubPlan(page, p);
  await page.goto("/start?runner=api");
  await page.getByTestId("choose-video-input").setInputFiles(WALKTHROUGH);
  await page.getByRole("button", { name: "Make my work plan" }).click();
  const problems = page.locator("#problems");
  await expect(problems.getByText(/No problems found in the frames we looked at/)).toBeVisible({ timeout: 30_000 });
  await expect(problems.getByTestId("coverage-note")).toContainText("Why no problems:");
  await expect(problems.getByTestId("watch-list")).toBeVisible();
  await expectNoAxeViolations(page, "empty plan with closer-look list");
  await shot(page, "problems-empty", problems);
});

test("the real sanctuary run carries the richer fields: tiers, a checklist and a cost share on every problem, no closer-look list", async ({ page }) => {
  await page.goto("/start?view=example&ex=sanctuary");
  const problems = page.locator("#problems");
  await expect(problems.getByRole("heading", { name: /^Fix now/ })).toBeVisible();
  await expect(page.getByTestId("watch-list")).toHaveCount(0);
  await expect(page.getByTestId("checklist")).toHaveCount(1);
  await expect(page.getByTestId("issue-cost")).toHaveCount(6);
  await expect(page.getByText("Partly backed", { exact: true })).toHaveCount(0);
  await expectNoSideScroll(page);
  await expectNoAxeViolations(page, "real run with the richer fields");
});

test("featured kitchen sample (the public default) shows tiers, where and what, the closer-look list and the checklist at 375, 768 and 1280", async ({ page }) => {
  for (const width of [375, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/start?view=example&ex=kitchen");
    const problems = page.locator("#problems");
    for (const name of [/^Fix now/, /^Fix soon/, /^Can wait/]) await expect(problems.getByRole("heading", { level: 3, name })).toBeVisible();
    const leak = problems.getByRole("listitem").filter({ hasText: "Shutoff valve under the sink is leaking" }).first();
    await expect(leak.getByText("Under the sink", { exact: true })).toBeVisible();
    const watch = page.getByTestId("watch-list");
    await watch.getByText("Worth a closer look").click();
    await expect(watch.getByText("Ladder and boards left standing in the walkway")).toBeVisible();
    await expect(watch.getByText("Loose wire on the floor by the fireplace")).toBeVisible();
    const checklist = page.getByTestId("checklist");
    await expect(checklist.getByRole("listitem").filter({ hasText: "Plumbing and water" })).toContainText("2 problems");
    await expect(checklist.getByRole("listitem").filter({ hasText: "Walls, paint and ceiling" })).toContainText("4 problems");
    await expectNoSideScroll(page);
    if (width === 375) await expectNoAxeViolations(page, "kitchen sample with the closer-look list open");
    await shot(page, "kitchen-sample");
  }
});

test("classroom, office and warehouse samples show tiers, where and what, and the closer-look find at 375, 768 and 1280", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  const cases = [
    { ex: "classroom", headings: [/^Fix now/, /^Fix soon/, /^Can wait/], problem: "Ceiling grid open", where: "Ceiling, whole room", watch: "Wall box at the waterline" },
    { ex: "office", headings: [/^Fix soon/, /^Can wait/], problem: "Floor outlet covers", where: "Carpet in front of the door and the windows", watch: "No blinds on a full wall of glass" },
    { ex: "warehouse", headings: [/^Fix now/, /^Fix soon/, /^Can wait/], problem: "Materials parked in the main drive aisle", where: "Center drive aisle", watch: "Loose stair units parked between the piles" },
  ];
  for (const width of [375, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    for (const c of cases) {
      await page.goto(`/start?view=example&ex=${c.ex}`);
      const problems = page.locator("#problems");
      for (const name of c.headings) await expect(problems.getByRole("heading", { level: 3, name })).toBeVisible();
      const item = problems.getByRole("listitem").filter({ hasText: c.problem }).first();
      await expect(item.getByText(c.where, { exact: true })).toBeVisible();
      const watch = page.getByTestId("watch-list");
      await watch.getByText("Worth a closer look").click();
      await expect(watch.getByText(c.watch)).toBeVisible();
      await expectNoSideScroll(page);
      if (width === 375) await expectNoAxeViolations(page, `${c.ex} sample with the closer-look list open`);
      if (width === 375) await shot(page, `${c.ex}-sample`);
    }
  }
  expect(errors).toEqual([]);
});
