import { test, expect, expectNoAxeViolations, expectNoSideScroll } from "./helpers";

// /api stays blocked (helpers.ts) and console errors fail the test. The e2e build turns the flag on.
test.beforeEach(async ({ apiCalls, pageErrors }) => {
  void apiCalls;
  void pageErrors;
});

test("own-key guide is linked from Settings, reads cleanly at every width, and links back", async ({ page }) => {
  for (const width of [375, 768, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto("/settings");
    await page.getByTestId("own-key-guide-link").click();
    await expect(page).toHaveURL(/\/help\/own-key$/);
    await expect(page.getByRole("heading", { level: 1, name: "How to use your own Meta API key" })).toBeVisible();

    // The labels the guide names are the real ones on the Settings screen.
    for (const text of ["Create API key", "Meta API key", "Save key", "Forget key", "Key saved in this browser."]) {
      await expect(page.locator("main").getByText(text, { exact: true }).first()).toBeVisible();
    }
    await expect(page.getByTestId("own-key-billing")).toContainText("SightWork doesn't cover it or bill you for it");
    await expect(page.getByText("never sent to SightWork's servers", { exact: false })).toBeVisible();

    // Meta links open Meta's official docs in a new tab.
    const auth = page.getByRole("link", { name: /Authentication \(get an API key\)/ });
    await expect(auth).toHaveAttribute("href", "https://dev.meta.ai/docs/authentication");
    await expect(auth).toHaveAttribute("target", "_blank");
    await expect(page.getByRole("link", { name: /Meta Model API pricing/ })).toHaveAttribute("href", "https://dev.meta.ai/docs/pricing-rate-limits");

    await expectNoSideScroll(page);
    await expectNoAxeViolations(page, `own-key guide ${width}`);

    await page.getByRole("link", { name: "Add your key in Settings" }).click();
    await expect(page).toHaveURL(/\/settings$/);
    await expect(page.getByTestId("byok-card")).toBeVisible();
  }
});
