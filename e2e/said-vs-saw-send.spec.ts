import { test, expect, expectNoAxeViolations, expectNoSideScroll } from "./helpers";

// /api stays blocked (helpers.ts) and console errors fail the test. Desktop Chromium has no share sheet here, so the
// button falls back to the clipboard. The kitchen example has 3 matched and 3 unmentioned rows.
test.beforeEach(async ({ apiCalls, pageErrors }) => {
  void apiCalls;
  void pageErrors;
});

test("said vs saw sends the rows on screen and follows the toggle", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/start?view=example&ex=kitchen");
  const section = page.locator("#said-vs-saw");
  const button = section.getByTestId("send-said-vs-saw");
  await expect(button).toHaveAccessibleName("Send this list");
  await button.click();
  await expect(section.getByTestId("send-said-vs-saw-status")).toHaveText(/Copied/);
  let text = await page.evaluate(() => navigator.clipboard.readText());
  expect(text.startsWith("Example plan, not a real walkthrough.\nWhat you said vs. what we saw")).toBe(true);
  expect(text).toContain("You didn't mention (3):");
  expect(text).toContain("Matched (3):");
  expect(text).toContain("Made with SightWork");

  await section.getByTestId("said-vs-saw-only-unmentioned").click();
  await expect(button).toHaveAccessibleName("Send what you didn't mention");
  await button.click();
  text = await page.evaluate(() => navigator.clipboard.readText());
  expect(text).toContain("You didn't mention (3):");
  expect(text).not.toContain("Matched");

  for (const width of [375, 768, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    await button.evaluate((el) => el.scrollIntoView({ block: "center" }));
    await expectNoSideScroll(page);
    await expectNoAxeViolations(page, `send said vs saw ${width}`);
  }
});

test("print hides the said vs saw send button", async ({ page }) => {
  await page.goto("/start?view=example&ex=kitchen");
  await expect(page.getByTestId("send-said-vs-saw")).toBeVisible();
  await page.emulateMedia({ media: "print" });
  await expect(page.getByTestId("send-said-vs-saw")).toBeHidden();
});
