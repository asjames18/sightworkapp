import { test, expect, WALKTHROUGH, expectNoAxeViolations, expectNoSideScroll } from "./helpers";

// /api stays blocked (helpers.ts) and console errors fail the test. The e2e build turns own-key mode on.
test.beforeEach(async ({ apiCalls, pageErrors }) => {
  void apiCalls;
  void pageErrors;
});

const KEY = "LLM_e2eFakeKey_0123456789abcdefghijklmnop";

test("with a key saved, the user's video goes to the own-key runner: no tester code, no server call, no key sent", async ({ page }) => {
  const seen: string[] = [];
  page.on("request", (r) => seen.push(`${r.url()} ${JSON.stringify(r.headers())} ${r.postData() ?? ""}`));

  await page.goto("/settings");
  await page.evaluate((k) => localStorage.setItem("sightwork:byok:meta:v1", k), KEY);

  for (const width of [375, 768, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto("/start");
    await page.getByTestId("choose-video-input").setInputFiles(WALKTHROUGH);
    await page.getByRole("button", { name: "Make my work plan" }).click();
    // No tester code prompt: an own-key run doesn't spend SightWork's credits.
    await expect(page.getByText("Enter the tester code to make a plan from this video.")).toHaveCount(0);
    await expect(page.getByRole("heading", { level: 1, name: "We couldn't finish your plan" })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("Runs on your own key aren't ready yet.", { exact: false })).toBeVisible();
    // Never the example plan passed off as theirs.
    await expect(page.getByRole("heading", { name: "Problems, worst first" })).toHaveCount(0);
    await expectNoSideScroll(page);
    await expectNoAxeViolations(page, `own-key run stop ${width}`);
  }

  expect(seen.filter((s) => s.includes(KEY)), "the key must never be in a request").toEqual([]);
  expect(seen.filter((s) => s.includes("api.meta.ai")), "no Meta call until the browser runner lands").toEqual([]);
  // The apiCalls fixture then checks that no /api request left the browser.
});

test("?runner=mock still previews the example plan with a key saved", async ({ page }) => {
  await page.goto("/settings");
  await page.evaluate((k) => localStorage.setItem("sightwork:byok:meta:v1", k), KEY);
  await page.goto("/start?runner=mock");
  await page.getByTestId("choose-video-input").setInputFiles(WALKTHROUGH);
  await page.getByRole("button", { name: "Make my work plan" }).click();
  await expect(page.getByRole("heading", { name: "Problems, worst first" })).toBeVisible({ timeout: 30_000 });
});
