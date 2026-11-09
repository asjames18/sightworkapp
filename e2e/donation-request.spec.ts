import { test, expect, expectNoAxeViolations, expectNoSideScroll } from "./helpers";

// /api stays blocked (helpers.ts) and console errors fail the test; the stored sanctuary run needs no model.
test.beforeEach(async ({ apiCalls, pageErrors }) => {
  void apiCalls;
  void pageErrors;
});

test("the shopping list can send a donation request for what is still needed", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  for (const width of [375, 768, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto("/start?view=example&ex=sanctuary");
    const button = page.getByTestId("donation-request");
    // Materials to the top (its scroll margin clears the sticky section chips), so no control above sits half under them
    // while axe runs; then the button itself into view.
    await page.locator("#materials").evaluate((el) => el.scrollIntoView({ block: "start" }));
    await button.scrollIntoViewIfNeeded();
    await expect(button).toBeVisible();
    await button.click();
    await expect(page.getByTestId("donation-request-status")).toHaveText("Copied. Paste it into a text or an email.");
    const text = await page.evaluate(() => navigator.clipboard.readText());
    expect(text).toMatch(/^Donation request: /);
    expect(text).toContain("donate, or give us a discount on");
    expect(text).toContain("Please reply with:");
    expect(text).toContain("Made with SightWork · https://sightwork.melanatedintech.com");
    expect(text).not.toMatch(/\$\d/);
    await expectNoSideScroll(page);
    await expectNoAxeViolations(page, `donation request ${width}`);
  }
});

test("the donation request is not printed", async ({ page }) => {
  await page.goto("/start?view=example&ex=sanctuary");
  await page.emulateMedia({ media: "print" });
  await expect(page.getByTestId("donation-request")).toBeHidden();
});
