import { test, expect, expectNoAxeViolations, expectNoSideScroll } from "./helpers";

// /api stays blocked (helpers.ts) and console errors fail the test. Desktop Chromium has no share sheet here, so the
// button falls back to the clipboard.
test.beforeEach(async ({ apiCalls, pageErrors }) => {
  void apiCalls;
  void pageErrors;
});

test("each problem card sends just that problem", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/start?view=example&ex=kitchen");
  const cards = page.locator('li[id^="problem-"]');
  const total = await cards.count();
  expect(total).toBeGreaterThan(0);
  await expect(page.getByTestId("send-problem")).toHaveCount(total);

  const first = cards.first();
  const title = (await first.locator("h3, h4").first().innerText()).trim();
  const button = first.getByTestId("send-problem");
  await expect(button).toHaveAccessibleName(/^Send this problem #\d+$/);
  await button.click();
  await expect(first.getByRole("status")).toHaveText(/Copied/);
  const text = await page.evaluate(() => navigator.clipboard.readText());
  expect(text.startsWith("Example plan, not a real inspection.\nProblem #")).toBe(true);
  expect(text).toContain(title);
  expect(text).toContain("Made with SightWork");

  for (const width of [375, 768, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    // The last card, centered: the sticky section chips then never half-cover the filter above the first card.
    await cards.last().getByTestId("send-problem").evaluate((el) => el.scrollIntoView({ block: "center" }));
    await expectNoSideScroll(page);
    await expectNoAxeViolations(page, `send problem ${width}`);
  }
});

test("print hides the send buttons", async ({ page }) => {
  await page.goto("/start?view=example&ex=kitchen");
  await expect(page.getByTestId("send-problem").first()).toBeVisible();
  await page.emulateMedia({ media: "print" });
  await expect(page.getByTestId("send-problem").first()).toBeHidden();
});
