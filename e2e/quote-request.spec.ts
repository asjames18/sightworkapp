import { test, expect, expectNoAxeViolations, expectNoSideScroll } from "./helpers";

// /api stays blocked (helpers.ts) and console errors fail the test; the stored sanctuary run needs no model.
test.beforeEach(async ({ apiCalls, pageErrors }) => {
  void apiCalls;
  void pageErrors;
});

test("each paid row sends a quote request, and the Volunteers row has none", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  for (const width of [375, 768, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto("/start?view=example&ex=sanctuary");
    const card = page.locator("#steps").getByTestId("crew-summary");
    await card.scrollIntoViewIfNeeded();
    const rows = card.getByTestId("crew-row");
    const paid = rows.filter({ hasText: "Paid" });
    expect(await paid.count()).toBeGreaterThan(0);
    await expect(paid.first().getByTestId("quote-request")).toBeVisible();
    await expect(rows.filter({ hasText: "Volunteers" }).getByTestId("quote-request")).toHaveCount(0);
    await paid.first().getByTestId("quote-request").click();
    await expect(paid.first().getByTestId("quote-request-status")).toHaveText("Copied. Paste it into a text or an email.");
    const text = await page.evaluate(() => navigator.clipboard.readText());
    expect(text).toMatch(/^Quote request: /);
    expect(text).toContain("The work:");
    expect(text).toContain("Please reply with:");
    expect(text).toContain("your price, and whether it includes materials");
    expect(text).toContain("Made with SightWork · https://sightwork.melanatedintech.com");
    expect(text).not.toMatch(/\$\d/);
    await expectNoSideScroll(page);
    await page.evaluate(() => window.scrollTo(0, 0));
    await expectNoAxeViolations(page, `quote request ${width}`);
  }
});

test("the quote request is not printed", async ({ page }) => {
  await page.goto("/start?view=example&ex=sanctuary");
  await page.emulateMedia({ media: "print" });
  await expect(page.getByTestId("quote-request").first()).toBeHidden();
});
