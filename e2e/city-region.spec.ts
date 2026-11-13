import fs from "node:fs";
import path from "node:path";
import { test, expect, WALKTHROUGH, expectNoAxeViolations, expectNoSideScroll } from "./helpers";

/**
 * City + state before a real run (Antonio, 2026-10-30 4:22 PM). /api stays blocked (helpers.ts) except
 * where a test stubs it in the browser; nothing reaches a server route or a model.
 * SHOT_DIR=<dir> saves the 390 px screenshots (field, blocked state, plan with the city).
 */
test.beforeEach(async ({ apiCalls, pageErrors }) => {
  void apiCalls;
  void pageErrors;
});

const sanctuary = JSON.parse(fs.readFileSync(path.join(__dirname, "../src/lib/examples/sanctuary-run.json"), "utf8"));
const shotDir = process.env.SHOT_DIR;
const shoot = async (page: import("@playwright/test").Page, name: string, el?: import("@playwright/test").Locator) => {
  if (!shotDir || test.info().project.name !== "phone-390") return;
  fs.mkdirSync(shotDir, { recursive: true });
  const file = path.join(shotDir, name);
  if (el) await el.screenshot({ path: file });
  else await page.screenshot({ path: file, fullPage: false });
};

test("real run: city and state are asked on the video card, and an empty one blocks the run with a clear message", async ({ page }) => {
  await page.goto("/start?runner=api");
  await page.getByTestId("choose-video-input").setInputFiles(WALKTHROUGH);
  const card = page.getByRole("group", { name: "Your walkthrough" });
  const city = card.getByLabel("City");
  const state = card.getByLabel("State");
  await expect(card.getByText("Where is this space?")).toBeVisible();
  await expect(city).toHaveValue("");
  await expect(state).toHaveValue("");
  await expectNoSideScroll(page);
  await expectNoAxeViolations(page, "city and state on the video card");
  await card.getByTestId("location-fields").scrollIntoViewIfNeeded();
  await shoot(page, "city-region-field-390.png", card);

  await card.getByRole("button", { name: "Make my work plan" }).click();
  await expect(card.getByRole("alert").filter({ hasText: "Add the city and state where this space is." })).toBeVisible();
  await expect(city).toBeFocused();
  await expect(city).toHaveAttribute("aria-invalid", "true");
  // Blocked before anything else: no code prompt, no run.
  await expect(card.getByTestId("run-choice")).toHaveCount(0);
  await expect(page.getByRole("heading", { level: 1, name: "Working on your plan" })).toHaveCount(0);
  await expectNoAxeViolations(page, "city and state missing");
  await shoot(page, "city-region-blocked-390.png", card);

  await city.fill("Sebring");
  await card.getByRole("button", { name: "Make my work plan" }).click();
  await expect(card.getByRole("alert").filter({ hasText: "Pick the state where this space is" })).toBeVisible();
  await expect(state).toBeFocused();

  await state.selectOption("FL");
  await expect(card.getByRole("alert").filter({ hasText: /state where this space is/ })).toHaveCount(0);
  // Both filled: on to the tester-code prompt (no code saved), still nothing sent.
  await card.getByRole("button", { name: "Make my work plan" }).click();
  await expect(card.getByTestId("run-choice")).toBeVisible();
});

test("city and state are remembered on this device", async ({ page }) => {
  await page.goto("/start?runner=api");
  await page.getByTestId("choose-video-input").setInputFiles(WALKTHROUGH);
  const card = page.getByRole("group", { name: "Your walkthrough" });
  await card.getByLabel("City").fill("Sebring");
  await card.getByLabel("State").selectOption("FL");
  expect(await page.evaluate(() => window.localStorage.getItem("sightwork:location"))).toBe(JSON.stringify({ city: "Sebring", state: "FL" }));
  await page.reload();
  await page.getByTestId("choose-video-input").setInputFiles(WALKTHROUGH);
  await expect(card.getByLabel("City")).toHaveValue("Sebring");
  await expect(card.getByLabel("State")).toHaveValue("FL");
});

test("recorded take: blocked the same way until city and state are filled", async ({ page }) => {
  await page.addInitScript(() => window.localStorage.setItem("sightwork:test-code", "stub-code"));
  await page.goto("/start?runner=api");
  await page.getByRole("button", { name: "Record a walkthrough" }).click();
  const cam = page.getByRole("group", { name: "Camera" });
  await expect(cam).toHaveAttribute("data-phase", "ready");
  await cam.getByRole("button", { name: "Start recording" }).click();
  await page.waitForTimeout(6300);
  await cam.getByRole("button", { name: "Stop recording" }).click();
  const card = page.getByRole("group", { name: "Your walkthrough" });
  await expect(card).toContainText(/walkthrough-\d{4}-\d{2}-\d{2}-\d{4}\.(webm|mp4)/);
  await card.getByRole("button", { name: "Make my work plan" }).click();
  await expect(card.getByRole("alert").filter({ hasText: "Add the city and state where this space is." })).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: "Working on your plan" })).toHaveCount(0);
});

test("the run sends 'City, ST' as region and the plan says which area it priced for", async ({ page }) => {
  let region: string | undefined;
  const plan = {
    ...sanctuary,
    meta: { ...sanctuary.meta, isExample: undefined },
    costRange: {
      low: 420,
      high: 760,
      currency: "USD",
      label: "Rough estimate, not a quote",
      region: "Sebring, FL",
      laborBasis: "volunteer",
      assumptions: ["Test stub: prices are made up for this check."],
      pricing: { priced: 6, grounded: 4 },
    },
  };
  await page.route("**/api/transcribe", (r) => r.fulfill({ json: { transcript: "", transcriptTurns: [] } }));
  await page.route("**/api/plan", (r) => {
    region = (JSON.parse(r.request().postData() ?? "{}") as { region?: string }).region;
    return r.fulfill({ contentType: "application/x-ndjson", body: JSON.stringify({ state: "done", plan }) + "\n" });
  });
  await page.addInitScript(() => window.localStorage.setItem("sightwork:test-code", "stub-code"));
  await page.goto("/start?runner=api");
  await page.getByTestId("choose-video-input").setInputFiles(WALKTHROUGH);
  const card = page.getByRole("group", { name: "Your walkthrough" });
  await card.getByLabel("City").fill("  Sebring ");
  await card.getByLabel("State").selectOption("FL");
  await card.getByRole("button", { name: "Make my work plan" }).click();
  const heading = page.getByRole("heading", { name: "Cost range for Sebring, FL" });
  await expect(heading).toBeVisible({ timeout: 30_000 });
  expect(region).toBe("Sebring, FL");
  await expect(page.getByTestId("cost-live-prices")).toHaveText("4 of 6 material prices looked up live on the web for Sebring, FL; the rest are regional estimates.");
  await page.locator("#cost summary").click();
  await expect(page.getByTestId("area-index")).toContainText("Florida: materials about 0.99x, labor about 0.85x the US average.");
  await expect(page.getByTestId("area-index")).toContainText("Estimate from state averages, not a quote");
  await expectNoSideScroll(page);
  await expectNoAxeViolations(page, "plan with the city on the cost range");
  await page.locator("#cost").scrollIntoViewIfNeeded();
  await shoot(page, "city-region-plan-390.png", page.locator("#cost"));
});

test("example plans and the example preview are unaffected", async ({ page }) => {
  await page.goto("/start?view=example&ex=office");
  await expect(page.getByRole("heading", { name: "Problems, worst first" })).toBeVisible();
  await expect(page.getByRole("heading", { name: /Cost range for/ })).toHaveCount(0);
  // The real sanctuary run keeps the place it was priced for.
  await page.goto("/start?view=example&ex=sanctuary");
  await expect(page.getByRole("heading", { name: "Cost range for Sebring, FL" })).toBeVisible();
  await page.goto("/start?runner=mock");
  await page.getByTestId("choose-video-input").setInputFiles(WALKTHROUGH);
  const card = page.getByRole("group", { name: "Your walkthrough" });
  await expect(card.getByTestId("location-fields")).toHaveCount(0);
  await card.getByRole("button", { name: "Make my work plan" }).click();
  await expect(page.getByRole("heading", { name: "Problems, worst first" })).toBeVisible({ timeout: 30_000 });
});

test("cost step failed: the plan still says where it is and offers to price it for that city", async ({ page }) => {
  const plan = {
    ...sanctuary,
    meta: { ...sanctuary.meta, isExample: undefined, skipped: { cost: true } },
    costRange: null,
  };
  await page.route("**/api/transcribe", (r) => r.fulfill({ json: { transcript: "", transcriptTurns: [] } }));
  await page.route("**/api/plan", (r) =>
    r.fulfill({ contentType: "application/x-ndjson", body: JSON.stringify({ state: "done", plan }) + "\n" }),
  );
  await page.addInitScript(() => window.localStorage.setItem("sightwork:test-code", "stub-code"));
  await page.goto("/start?runner=api");
  await page.getByTestId("choose-video-input").setInputFiles(WALKTHROUGH);
  const card = page.getByRole("group", { name: "Your walkthrough" });
  await card.getByLabel("City").fill("Sebring");
  await card.getByLabel("State").selectOption("FL");
  await card.getByRole("button", { name: "Make my work plan" }).click();
  await expect(page.getByTestId("plan-location")).toHaveText(/Sebring, FL/, { timeout: 30_000 });
  await expect(page.getByRole("heading", { name: /Cost range for/ })).toHaveCount(0);
  await expect(page.getByText("try again to price them for Sebring, FL.")).toBeVisible();
  await expectNoSideScroll(page);
  await expectNoAxeViolations(page, "plan with a city but no cost range");
  await shoot(page, "city-region-no-cost-390.png");
});
