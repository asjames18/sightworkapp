import { test, expect, expectNoAxeViolations, expectNoSideScroll } from "./helpers";

// /api stays blocked (helpers.ts) and console errors fail the test. Desktop Chromium has no share sheet here, so the
// button falls back to the clipboard.
test.beforeEach(async ({ apiCalls, pageErrors }) => {
  void apiCalls;
  void pageErrors;
});

test("the counts section sends just the counts", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/start?view=example&ex=kitchen");
  const counts = page.locator("#counts");
  const button = counts.getByTestId("send-counts");
  await expect(button).toHaveCount(1);
  await expect(button).toHaveAccessibleName("Send the counts");
  await button.click();
  await expect(counts.getByRole("status")).toHaveText(/Copied/);
  const text = await page.evaluate(() => navigator.clipboard.readText());
  expect(text.startsWith("Example plan, not a real count.\nCounts")).toBe(true);
  const label = (await counts.locator("li").first().locator("p").nth(1).innerText()).trim();
  expect(text).toMatch(new RegExp(`\\n- \\d+(-\\d+)? ${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  expect(text).toContain("Made with SightWork");

  for (const width of [375, 768, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    await button.evaluate((el) => el.scrollIntoView({ block: "center" }));
    await expectNoSideScroll(page);
    await expectNoAxeViolations(page, `send counts ${width}`);
  }
});

test("print hides the send counts button", async ({ page }) => {
  await page.goto("/start?view=example&ex=kitchen");
  await expect(page.getByTestId("send-counts")).toBeVisible();
  await page.emulateMedia({ media: "print" });
  await expect(page.getByTestId("send-counts")).toBeHidden();
});
