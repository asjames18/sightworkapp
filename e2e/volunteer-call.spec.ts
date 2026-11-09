import { test, expect, expectNoAxeViolations, expectNoSideScroll } from "./helpers";

// /api stays blocked (helpers.ts) and console errors fail the test; the stored sanctuary run needs no model.
test.beforeEach(async ({ apiCalls, pageErrors }) => {
  void apiCalls;
  void pageErrors;
});

test("the Volunteers row sends a call for help, and paid rows have no such button", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  for (const width of [375, 768, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto("/start?view=example&ex=sanctuary");
    const card = page.locator("#steps").getByTestId("crew-summary");
    await card.scrollIntoViewIfNeeded();
    const rows = card.getByTestId("crew-row");
    const volunteers = rows.filter({ hasText: "Volunteers" });
    const ask = volunteers.getByTestId("volunteer-call");
    await expect(ask).toBeVisible();
    await expect(card.getByTestId("volunteer-call")).toHaveCount(1);
    await ask.click();
    await expect(card.getByTestId("volunteer-call-status")).toHaveText("Copied. Paste it into a text or an announcement.");
    const text = await page.evaluate(() => navigator.clipboard.readText());
    expect(text).toMatch(/^Volunteers needed: /);
    expect(text).toContain("could use your help.");
    expect(text).toContain("What volunteers will do");
    expect(text).toContain("Reply if you can help, and tell us which days work for you.");
    expect(text.trimEnd().endsWith("Made with SightWork \u00B7 https://sightwork.melanatedintech.com")).toBe(true);
    await expectNoSideScroll(page);
    await page.evaluate(() => window.scrollTo(0, 0));
    await expectNoAxeViolations(page, `volunteer call ${width}`);
  }
});

test("the call for help is not printed", async ({ page }) => {
  await page.goto("/start?view=example&ex=sanctuary");
  await page.emulateMedia({ media: "print" });
  await expect(page.getByTestId("volunteer-call")).toBeHidden();
});
