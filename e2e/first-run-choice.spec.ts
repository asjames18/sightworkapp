import { test, expect, expectNoAxeViolations, expectNoSideScroll, WALKTHROUGH } from "./helpers";

test.beforeEach(async ({ apiCalls, pageErrors }) => {
  void apiCalls;
  void pageErrors;
});

const KEY = "LLM_" + "k".repeat(36);

test("home and app headers link Pricing and the own-key Settings; the hero names both ways", async ({ page }) => {
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto("/");
    const nav = page.getByTestId("access-nav").first();
    await expect(nav.getByRole("link", { name: "Pricing" })).toHaveAttribute("href", "/pricing");
    await expect(nav.getByRole("link", { name: /Own key|Use your own key/ })).toHaveAttribute("href", "/settings");
    const hero = page.getByTestId("hero-access");
    await expect(hero.getByRole("link", { name: "Free with your own Meta API key" })).toHaveAttribute("href", "/settings");
    await expect(hero.getByRole("link", { name: "buy plans" })).toHaveAttribute("href", "/pricing");
    await expectNoSideScroll(page);
    await expectNoAxeViolations(page, `home ${width}`);

    await page.goto("/start");
    const appNav = page.getByTestId("access-nav");
    await expect(appNav.getByRole("link", { name: "Pricing" })).toBeVisible();
    await expect(appNav.getByRole("link", { name: /Own key|Use your own key/ })).toBeVisible();
    await expectNoSideScroll(page);
  }
});

test("saving a key at the gate opens filming, and the example plan stays free behind it", async ({ page }) => {
  await page.goto("/start?runner=api");
  const gate = page.getByTestId("start-gate");
  await expect(gate).toBeVisible();
  await expect(page.locator("#examples-heading")).toBeVisible();
  await gate.getByLabel("Your Meta API key").fill("short");
  await gate.getByRole("button", { name: "Save key" }).click();
  await expect(gate.getByRole("alert")).toContainText("too short");
  await gate.getByLabel("Your Meta API key").fill(KEY);
  await gate.getByRole("button", { name: "Save key" }).click();
  await expect(page.getByTestId("start-gate")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Record a walkthrough" })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("sightwork:byok:meta:v1"))).toBe(KEY);
});

test("an access code saved at the gate opens filming", async ({ page }) => {
  await page.goto("/start?runner=api");
  const gate = page.getByTestId("start-gate");
  await gate.getByLabel("Access code").fill("sw1.eyJrIjoicGFjayJ9.c2lnbmF0dXJl");
  await gate.getByRole("button", { name: "Save code" }).click();
  await expect(page.getByTestId("start-gate")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Choose a video" })).toBeVisible();
});

test.describe("a run the server refuses for payment", () => {
  test.use({ expectedConsoleErrors: [/status of 402/] });
  test("links Pricing and Settings and goes back to the choice with the same video", async ({ page }) => {
    await page.route("**/api/transcribe", (r) => r.fulfill({ status: 402, json: { error: "Plan runs need a paid access code." } }));
    await page.route("**/api/plan", (r) => r.fulfill({ status: 402, json: { error: "Plan runs need a paid access code." } }));
    await page.addInitScript(() => {
      window.localStorage.setItem("sightwork:test-code", "old-tester-code");
      window.localStorage.setItem("sightwork:location", JSON.stringify({ city: "Sebring", state: "FL" }));
    });
    await page.goto("/start?runner=api");
    await page.getByTestId("choose-video-input").setInputFiles(WALKTHROUGH);
    await page.getByRole("button", { name: "Make my work plan" }).click();
    const links = page.getByTestId("paid-refusal-links");
    await expect(links).toBeVisible({ timeout: 30_000 });
    await expect(links.getByRole("link", { name: "Buy plans" })).toHaveAttribute("href", "/pricing");
    await expect(links.getByRole("link", { name: "Use your own key (free)" })).toHaveAttribute("href", "/settings");
    await page.getByRole("button", { name: "Use your own key or buy plans" }).click();
    const card = page.getByRole("group", { name: "Your walkthrough" });
    await expect(card).toContainText("walkthrough-6s.webm");
    await expect(card.getByTestId("run-choice")).toBeVisible();
  });
});
