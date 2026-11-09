import { test, expect, expectNoAxeViolations, expectNoSideScroll } from "./helpers";

// /api stays blocked (helpers.ts) and console errors fail the test. Desktop Chromium has no share sheet here, so the
// button falls back to the clipboard. The kitchen example has two "Worth a closer look" finds.
test.beforeEach(async ({ apiCalls, pageErrors }) => {
  void apiCalls;
  void pageErrors;
});

test("Send these to check hands over the closer-look finds", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/start?view=example&ex=kitchen");
  const watch = page.getByTestId("watch-list");
  await expect(watch).toBeVisible();
  const button = watch.getByTestId("send-watch");
  await expect(button).toBeHidden();

  await watch.getByText("Worth a closer look").click();
  await expect(button).toBeVisible();
  await expect(button).toHaveAccessibleName("Send these to check");
  await button.click();
  await expect(watch.getByRole("status")).toHaveText(/Copied/);
  const text = await page.evaluate(() => navigator.clipboard.readText());
  const lines = text.split("\n");
  expect(lines[0]).toBe("Example plan, not a real inspection.");
  expect(lines[1]).toMatch(/^Worth a closer look/);
  expect(lines[2]).toBe("2 lower-confidence finds to check in person. Not in the ranked problems or the work order.");
  expect(text).toContain("\n- Ladder and boards left standing in the walkway (Middle of the kitchen floor, 40% sure)\n");
  expect(text).toContain("\n- Loose wire on the floor by the fireplace (Hearth, by the paint bucket, 36% sure)\n");
  expect(text).toContain("\n  A thin wire lies across the floor at the hearth. Check whether it is old or live wiring");
  expect(text).toContain("Made with SightWork");

  for (const width of [375, 768, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    await button.evaluate((el) => el.scrollIntoView({ block: "center" }));
    await expect(button).toBeVisible();
    await expectNoSideScroll(page);
    await expectNoAxeViolations(page, `send watch ${width}`);
  }
});

test("print hides the Send these to check button", async ({ page }) => {
  await page.goto("/start?view=example&ex=kitchen");
  const watch = page.getByTestId("watch-list");
  await watch.getByText("Worth a closer look").click();
  await expect(watch.getByTestId("send-watch")).toBeVisible();
  await page.emulateMedia({ media: "print" });
  await expect(watch.getByTestId("send-watch")).toBeHidden();
});
