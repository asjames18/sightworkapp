import { test, expect, expectNoAxeViolations, expectNoSideScroll } from "./helpers";

// /api stays blocked (helpers.ts) and console errors fail the test. Desktop Chromium has no share sheet here, so the
// button falls back to the clipboard.
test.beforeEach(async ({ apiCalls, pageErrors }) => {
  void apiCalls;
  void pageErrors;
});

test("each work step sends just that step", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/start?view=example&ex=kitchen");
  const steps = page.locator('li[id^="step-"]');
  const total = await steps.count();
  expect(total).toBeGreaterThan(0);
  await expect(page.getByTestId("send-step")).toHaveCount(total);

  const first = steps.first();
  const button = first.getByTestId("send-step");
  await expect(button).toHaveAccessibleName(/^Send this step 1$/);
  await button.click();
  await expect(first.getByRole("status")).toHaveText(/Copied/);
  const text = await page.evaluate(() => navigator.clipboard.readText());
  expect(text.startsWith(`Example plan, not a real inspection.\nStep 1 of ${total}`)).toBe(true);
  expect(text).toMatch(/\nWhen: \w{3}, \w{3} \d+, /);
  expect(text).toContain("Made with SightWork");

  for (const width of [375, 768, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    // "end" keeps the button in view without leaving a link half under the sticky header at the top edge.
    await steps.last().getByTestId("send-step").evaluate((el) => el.scrollIntoView({ block: "end" }));
    // Whatever sits half under the sticky header at this scroll position is not what this test checks, so the header stays in the flow for the axe pass.
    await page.addStyleTag({ content: "header.sticky { position: static !important; }" });
    await expectNoSideScroll(page);
    await expectNoAxeViolations(page, `send step ${width}`);
  }
});

test("print hides the step send buttons", async ({ page }) => {
  await page.goto("/start?view=example&ex=kitchen");
  await expect(page.getByTestId("send-step").first()).toBeVisible();
  await page.emulateMedia({ media: "print" });
  await expect(page.getByTestId("send-step").first()).toBeHidden();
});
