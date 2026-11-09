import { test, expect, expectNoSideScroll } from "./helpers";

/**
 * No-JavaScript note: with scripts off, the page says plainly why nothing works instead of looking
 * broken. /api stays blocked (helpers.ts); nothing here reaches a model.
 */
test.beforeEach(async ({ apiCalls }) => {
  void apiCalls;
});

test.describe("scripts off", () => {
  test.use({ javaScriptEnabled: false });
  for (const width of [375, 768, 1280]) {
    test(`the page tells you to turn JavaScript on (${width} px)`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/");
      const note = page.getByTestId("noscript-note");
      await expect(note).toBeVisible();
      await expect(note).toContainText("SightWork needs JavaScript.");
      await expectNoSideScroll(page);
    });
  }
});

test("the note stays out of the way when scripts are on", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("noscript-note")).toHaveCount(0);
  await expect(page.getByTestId("noscript-note")).toBeHidden();
});
