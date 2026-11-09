import { test, expect, expectNoAxeViolations, expectNoSideScroll } from "./helpers";

/**
 * "What SightWork checked": each area that turned something up lists its problem numbers, and each number
 * jumps to that problem's card, even when the problem filter has that card hidden.
 */
test.beforeEach(async ({ apiCalls, pageErrors }) => {
  void apiCalls;
  void pageErrors;
});

for (const width of [375, 768, 1280]) {
  test(`checklist areas link to their problems (${width} px)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/start?view=example");
    await expect(page.getByRole("heading", { name: "Problems, worst first" })).toBeVisible({ timeout: 30_000 });
    const checklist = page.getByTestId("checklist");
    const areas = checklist.getByTestId("checklist-area");
    expect(await areas.count()).toBeGreaterThan(1);

    // Every area row's number of links matches its "N problems" count.
    for (let i = 0; i < (await areas.count()); i++) {
      const row = areas.nth(i);
      const text = (await row.innerText()) ?? "";
      const found = Number(/(\d+) problems?/.exec(text)?.[1] ?? 0);
      await expect(row.getByRole("link")).toHaveCount(found);
    }

    const walls = areas.filter({ hasText: "Walls, paint and ceiling" });
    const links = walls.getByRole("link");
    expect(await links.count()).toBeGreaterThan(1);
    await expect(walls.getByTestId("checklist-problems")).toHaveAccessibleName(/^Problems in Walls, paint and ceiling: \d/);
    const last = links.last();
    await expect(last).toHaveAccessibleName(/^Problem \d+$/);
    const box = await last.boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(24);
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(24);
    const href = await last.getAttribute("href");
    expect(href).toMatch(/^#problem-\d+$/);
    await last.click();
    await expect(page).toHaveURL(new RegExp(`${href}$`));
    await expect(page.locator(href as string)).toBeInViewport();

    await page.evaluate(() => window.scrollTo(0, 0));
    await expectNoSideScroll(page);
    await expectNoAxeViolations(page, `checklist links (${width} px)`);
  });
}

test("a checklist link still lands when the filter hides that problem", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto("/start?view=example");
  await expect(page.getByRole("heading", { name: "Problems, worst first" })).toBeVisible({ timeout: 30_000 });
  // Show only the problems the narration didn't mention; problem 2 was said out loud, so its card goes away.
  await page.getByTestId("unmentioned-filter").getByRole("button", { name: /You didn't mention/ }).click();
  await expect(page.locator("#problem-2")).toHaveCount(0);
  await page.getByTestId("checklist").locator('a[href="#problem-2"]').click();
  await expect(page.locator("#problem-2")).toBeInViewport();
  await expect(page).toHaveURL(/#problem-2$/);
});
