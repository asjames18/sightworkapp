import { test, expect, WALKTHROUGH, expectNoAxeViolations, expectNoSideScroll } from "./helpers";

// /api stays blocked (helpers.ts) and console errors fail the test. The e2e build turns own-key mode on.
test.beforeEach(async ({ apiCalls, pageErrors }) => {
  void apiCalls;
  void pageErrors;
});

const KEY = "LLM_e2eFakeKey_0123456789abcdefghijklmnop";

test.describe("Meta refuses the key", () => {
// The stand-in answers 401, which the browser logs as a failed resource load.
test.use({ expectedConsoleErrors: [/status of 401/] });
test("with a key saved, the run goes from this browser to Meta with the key: no tester code, nothing to /api, a refused key is said plainly", async ({ page }) => {
  const meta: { url: string; auth: string | undefined }[] = [];
  const others: string[] = [];
  page.on("request", (r) => {
    if (r.url().startsWith("https://api.meta.ai/")) return;
    others.push(`${r.url()} ${JSON.stringify(r.headers())} ${r.postData() ?? ""}`);
  });
  // Stand-in for Meta: every call is refused, so nothing is spent and the refused-key path is checked.
  await page.route("https://api.meta.ai/**", (r) => {
    meta.push({ url: r.request().url(), auth: r.request().headers()["authorization"] });
    return r.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ error: { message: "invalid key" } }) });
  });
  await page.addInitScript((k) => {
    window.localStorage.setItem("sightwork:byok:meta:v1", k);
    window.localStorage.setItem("sightwork:location", JSON.stringify({ city: "Sebring", state: "FL" }));
  }, KEY);

  for (const width of [375, 768, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto("/start");
    await page.getByTestId("choose-video-input").setInputFiles(WALKTHROUGH);
    await page.getByRole("button", { name: "Make my work plan" }).click();
    await expect(page.getByText("Enter the tester code to make a plan from this video.")).toHaveCount(0);
    await expect(page.getByRole("heading", { level: 1, name: "We couldn't finish your plan" })).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText("Meta didn't accept your API key.", { exact: false })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Problems, worst first" })).toHaveCount(0);
    await expectNoSideScroll(page);
    await expectNoAxeViolations(page, `own-key refused ${width}`);
  }

  expect(meta.length, "the run called Meta from the browser").toBeGreaterThan(0);
  for (const m of meta) expect(m.auth).toBe(`Bearer ${KEY}`);
  expect(others.filter((s) => s.includes(KEY)), "the key must never go anywhere but Meta").toEqual([]);
  // The apiCalls fixture then checks that no /api request left the browser.
});
});

test("with a key but no city, the own-key run asks for the city first and calls nothing", async ({ page }) => {
  const meta: string[] = [];
  await page.route("https://api.meta.ai/**", (r) => { meta.push(r.request().url()); return r.abort(); });
  await page.addInitScript((k) => window.localStorage.setItem("sightwork:byok:meta:v1", k), KEY);
  await page.goto("/start");
  await page.getByTestId("choose-video-input").setInputFiles(WALKTHROUGH);
  await page.getByRole("button", { name: "Make my work plan" }).click();
  await expect(page.getByText("Add the city and state where this space is", { exact: false }).first()).toBeVisible({ timeout: 30_000 });
  expect(meta).toEqual([]);
});

test("?runner=mock still previews the example plan with a key saved", async ({ page }) => {
  await page.addInitScript((k) => window.localStorage.setItem("sightwork:byok:meta:v1", k), KEY);
  await page.goto("/start?runner=mock");
  await page.getByTestId("choose-video-input").setInputFiles(WALKTHROUGH);
  await page.getByRole("button", { name: "Make my work plan" }).click();
  await expect(page.getByRole("heading", { name: "Problems, worst first" })).toBeVisible({ timeout: 30_000 });
});
