import { test, expect, WALKTHROUGH, expectNoAxeViolations, expectNoSideScroll } from "./helpers";

/**
 * Plan-ready tab cue: a preview run that finishes while the tab is hidden puts "Plan ready: N problems"
 * in the tab title until the tab is shown again. A run that finishes on screen leaves the title alone.
 * /api stays blocked (helpers.ts); the preview runner never reaches a model.
 */
test.beforeEach(async ({ apiCalls, pageErrors }) => {
  void apiCalls;
  void pageErrors;
});

async function setHidden(page: import("@playwright/test").Page, hidden: boolean) {
  await page.evaluate((h) => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => h });
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (h ? "hidden" : "visible") });
    document.dispatchEvent(new Event("visibilitychange"));
  }, hidden);
}

for (const width of [375, 768, 1280]) {
  test(`plan that finishes in a background tab cues the title (${width} px)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/start");
    const startTitle = await page.title();
    await page.getByTestId("choose-video-input").setInputFiles(WALKTHROUGH);
    await page.getByRole("button", { name: "Make my work plan" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Working on your plan" })).toBeVisible();
    await setHidden(page, true);
    await expect(page.getByRole("heading", { name: "Problems, worst first" })).toBeVisible({ timeout: 30_000 });
    await expect(page).toHaveTitle(/^Plan ready: \d+ problems? · SightWork$/);
    await setHidden(page, false);
    await expect(page).toHaveTitle(startTitle);
    await expectNoSideScroll(page);
    await expectNoAxeViolations(page, `plan after cue (${width} px)`);
  });
}

test("plan that finishes on screen keeps the normal title", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/start");
  const startTitle = await page.title();
  await page.getByTestId("choose-video-input").setInputFiles(WALKTHROUGH);
  await page.getByRole("button", { name: "Make my work plan" }).click();
  await expect(page.getByRole("heading", { name: "Problems, worst first" })).toBeVisible({ timeout: 30_000 });
  await expect(page).toHaveTitle(startTitle);
});

async function recordBuzz(page: import("@playwright/test").Page, reduced = false) {
  await page.emulateMedia({ reducedMotion: reduced ? "reduce" : "no-preference" });
  await page.addInitScript(() => {
    const w = window as unknown as { __buzz: unknown[] };
    w.__buzz = [];
    Object.defineProperty(navigator, "vibrate", { configurable: true, value: (p: unknown) => (w.__buzz.push(p), true) });
  });
}

for (const width of [375, 768, 1280]) {
  test(`finished run buzzes once on a phone that can vibrate (${width} px)`, async ({ page }) => {
    await recordBuzz(page);
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/start");
    await page.getByTestId("choose-video-input").setInputFiles(WALKTHROUGH);
    await page.getByRole("button", { name: "Make my work plan" }).click();
    await expect(page.getByRole("heading", { name: "Problems, worst first" })).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => page.evaluate(() => (window as unknown as { __buzz: unknown[] }).__buzz)).toEqual([[70, 90, 70]]);
    await expectNoSideScroll(page);
  });
}

test("reduced motion: finished run does not buzz", async ({ page }) => {
  await recordBuzz(page, true);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/start");
  await page.getByTestId("choose-video-input").setInputFiles(WALKTHROUGH);
  await page.getByRole("button", { name: "Make my work plan" }).click();
  await expect(page.getByRole("heading", { name: "Problems, worst first" })).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => (window as unknown as { __buzz: unknown[] }).__buzz)).toEqual([]);
});
