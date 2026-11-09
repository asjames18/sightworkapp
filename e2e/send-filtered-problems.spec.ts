import { test, expect, expectNoAxeViolations, expectNoSideScroll } from "./helpers";

// /api stays blocked (helpers.ts) and console errors fail the test. Desktop Chromium has no share sheet here, so the
// button falls back to the clipboard. The kitchen example has some, not all, problems unmentioned.
test.beforeEach(async ({ apiCalls, pageErrors }) => {
  void apiCalls;
  void pageErrors;
});

test("with the filter on, Send these N sends just the problems shown", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/start?view=example&ex=kitchen");
  const filter = page.getByTestId("unmentioned-filter");
  await expect(filter).toBeVisible();
  const button = filter.getByTestId("send-shown-problems");
  await expect(button).toHaveCount(0);

  const only = filter.getByRole("button", { name: /^You didn.t mention \d+$/ });
  const total = Number((await filter.getByRole("button", { name: /^All \d+$/ }).innerText()).replace(/\D/g, ""));
  const unmentioned = Number((await only.innerText()).replace(/\D/g, ""));
  await only.click();
  await expect(button).toHaveCount(1);
  await expect(button).toHaveAccessibleName(unmentioned === 1 ? "Send this one problem" : `Send these ${unmentioned} problems`);
  await button.click();
  await expect(filter.getByRole("status")).toHaveText(/Copied/);
  const text = await page.evaluate(() => navigator.clipboard.readText());
  const lines = text.split("\n");
  expect(lines[0]).toBe("Example plan, not a real inspection.");
  expect(lines[1]).toMatch(/^Problems you didn't mention/);
  expect(lines[2]).toBe(`${unmentioned} of ${total} problems, spotted on video but not mentioned on the walk.`);
  const ranks = await page.locator('li[id^="problem-"]').evaluateAll((els) => els.map((e) => e.id.replace("problem-", "")));
  expect(ranks).toHaveLength(unmentioned);
  for (const rank of ranks) expect(text).toContain(`\n- #${rank} `);
  expect(lines.filter((l) => l.startsWith("- #"))).toHaveLength(unmentioned);
  expect(text).toContain("Made with SightWork");

  for (const width of [375, 768, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    await button.evaluate((el) => el.scrollIntoView({ block: "center" }));
    await expectNoSideScroll(page);
    await expectNoAxeViolations(page, `send shown problems ${width}`);
  }

  await filter.getByRole("button", { name: /^All \d+$/ }).click();
  await expect(button).toHaveCount(0);
});

test("print hides the Send these button with the filter", async ({ page }) => {
  await page.goto("/start?view=example&ex=kitchen");
  await page.getByTestId("unmentioned-filter").getByRole("button", { name: /^You didn.t mention \d+$/ }).click();
  await expect(page.getByTestId("send-shown-problems")).toBeVisible();
  await page.emulateMedia({ media: "print" });
  await expect(page.getByTestId("send-shown-problems")).toBeHidden();
});
