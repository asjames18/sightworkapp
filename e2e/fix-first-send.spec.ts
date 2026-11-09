import { test, expect, expectNoAxeViolations, expectNoSideScroll } from "./helpers";

// /api stays blocked (helpers.ts) and console errors fail the test; the stored sanctuary run needs no model.
// Desktop Chromium has no share sheet here, so "Send Start here" falls back to the clipboard.
test.beforeEach(async ({ apiCalls, pageErrors }) => {
  void apiCalls;
  void pageErrors;
});

test("Send Start here copies just the Fix now problems and the steps that fix them", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/start?view=example&ex=sanctuary");
  const card = page.getByTestId("fix-first");
  const button = card.getByTestId("send-fix-first");
  await expect(button).toHaveAccessibleName("Send Start here");
  await page.getByRole("checkbox", { name: /^Step 2 done:/ }).check();
  await button.click();
  await expect(card.getByRole("status")).toHaveText(/Copied/);
  const text = await page.evaluate(() => navigator.clipboard.readText());
  const lines = text.split("\n");
  expect(lines[0]).toBe("Example plan, not a real inspection.");
  expect(lines[1]).toMatch(/^Start here/);
  expect(text).toContain("4 problems are Fix now:\n- #");
  expect(text).toContain("These 4 steps take care of them:");
  expect(text).toMatch(/\n2\. .+, done\n/);
  expect(text).toContain("About 3–5.5 h of work");
  expect(text).toContain("Start here: 1 of 4 done.");
  expect(text).toContain("The other 2 steps can follow once these are done.");
  expect(text).toContain("Made with SightWork");

  for (const width of [375, 768, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    await card.scrollIntoViewIfNeeded();
    await expectNoSideScroll(page);
    await expectNoAxeViolations(page, `send start here ${width}`);
  }
});
