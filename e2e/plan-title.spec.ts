import { test, expect, WALKTHROUGH, expectNoAxeViolations, expectNoSideScroll } from "./helpers";

/**
 * Plan tab title: a plan reopened on this device (?view=last) names its space in the tab title;
 * example plans keep their own page title. /api stays blocked (helpers.ts); the preview runner never
 * reaches a model.
 */
test.beforeEach(async ({ apiCalls, pageErrors }) => {
  void apiCalls;
  void pageErrors;
});

for (const width of [375, 768, 1280]) {
  test(`reopened plan names its space in the tab title (${width} px)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/start");
    const startTitle = await page.title();
    await page.getByTestId("choose-video-input").setInputFiles(WALKTHROUGH);
    await page.getByRole("button", { name: "Make my work plan" }).click();
    await expect(page.getByRole("heading", { name: "Problems, worst first" })).toBeVisible({ timeout: 30_000 });
    // The preview run ends on an example plan, which keeps the normal title.
    await expect(page).toHaveTitle(startTitle);
    await page.goto("/start?view=last");
    await expect(page.getByRole("heading", { name: "Problems, worst first" })).toBeVisible({ timeout: 30_000 });
    const space = (await page.getByRole("heading", { level: 1 }).innerText()).replace(/\s+/g, " ").trim();
    const expected = /\bplan$/i.test(space) ? `${space} | SightWork` : `${space} plan | SightWork`;
    await expect(page).toHaveTitle(expected);
    await expectNoSideScroll(page);
    await expectNoAxeViolations(page, `reopened plan title (${width} px)`);
  });
}

test("example page keeps its own title", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/start?view=example");
  await expect(page.getByRole("heading", { name: "Problems, worst first" })).toBeVisible({ timeout: 30_000 });
  const space = (await page.getByRole("heading", { level: 1 }).innerText()).replace(/\s+/g, " ").trim();
  await expect(page).not.toHaveTitle(`${space} plan | SightWork`);
  await expect(page).toHaveTitle(/\| SightWork$/);
});
