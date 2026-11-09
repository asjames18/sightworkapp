import { test, expect, expectNoAxeViolations, expectNoSideScroll } from "./helpers";

// /api stays blocked (helpers.ts) and console errors fail the test. Desktop Chromium has no share sheet here, so the
// button falls back to the clipboard. Step ticks live in localStorage per plan.
test.beforeEach(async ({ apiCalls, pageErrors }) => {
  void apiCalls;
  void pageErrors;
});

test("Send the steps left hands over only the work still to do", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/start?view=example&ex=kitchen");
  const list = page.locator("#work-steps-list");
  const boxes = list.getByRole("checkbox", { name: /^Step \d+ done: / });
  const total = await boxes.count();
  expect(total).toBeGreaterThan(2);
  await expect(page.getByTestId("steps-left-send")).toHaveCount(0);

  await list.getByRole("checkbox", { name: /^Step 1 done: / }).check();
  await list.getByRole("checkbox", { name: /^Step 2 done: / }).check();
  const button = page.getByTestId("steps-left-send");
  await expect(button).toHaveText(`Send the ${total - 2} steps left`);
  await button.click();
  await expect(page.getByTestId("steps-left-status")).toHaveText(/Copied/);
  const text = await page.evaluate(() => navigator.clipboard.readText());
  const lines = text.split("\n");
  expect(lines[0]).toBe("Example plan, not a real inspection.");
  expect(lines[1]).toMatch(new RegExp(`: ${total - 2} of ${total} steps left$`));
  expect(text).not.toMatch(/^Step 1: /m);
  expect(text).not.toMatch(/^Step 2: /m);
  expect(text).toMatch(/^Step 3: /m);
  expect(text).toContain("Done: steps 1, 2.");
  expect(text).toContain("Made with SightWork");

  for (const width of [375, 768, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    // Put the button at the top of the window, so no row above it sits half under the sticky header for axe.
    await button.evaluate((el) => el.scrollIntoView({ block: "start" }));
    await page.evaluate(() => window.scrollBy(0, -140));
    await expect(button).toBeVisible();
    await expectNoSideScroll(page);
    await expectNoAxeViolations(page, `steps left send ${width}`);
  }

  // Ticking every step leaves nothing to send, so the button goes away; it is never on paper.
  for (let i = 0; i < total; i++) await boxes.nth(i).check();
  await expect(button).toHaveCount(0);
  await list.getByRole("checkbox", { name: /^Step 1 done: / }).uncheck();
  await expect(button).toHaveText("Send the last step");
  await page.emulateMedia({ media: "print" });
  await expect(button).toBeHidden();
});
