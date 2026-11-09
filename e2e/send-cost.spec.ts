import fs from "node:fs";
import path from "node:path";
import { test, expect, expectNoAxeViolations, expectNoSideScroll, WALKTHROUGH } from "./helpers";

/**
 * "Send the cost" on the cost card: the range, what drives it and what it assumes, as text for whoever approves the
 * spend. No model calls: /api/plan is answered in the browser with the real sanctuary run plus a cost range with
 * step shares. Desktop Chromium has no share sheet here, so the button falls back to the clipboard.
 */
const sanctuary = JSON.parse(fs.readFileSync(path.join(__dirname, "../src/lib/examples/sanctuary-run.json"), "utf8"));

function costedPlan() {
  const p = structuredClone(sanctuary);
  p.costRange = {
    low: 1180.5,
    high: 2643.2,
    currency: "USD",
    label: "Rough estimate, not a quote",
    region: "Sebring, FL",
    laborBasis: "mixed",
    assumptions: ["Mid-grade materials", "15% contingency on every line"],
    byStep: p.workOrder.map((s: { order: number }, i: number) => ({ order: s.order, low: [480.3, 520.1, 60, 120.1][i] ?? 0, high: [1120.8, 1120.3, 140, 262.1][i] ?? 0 })),
  };
  return p;
}

async function stubPlan(page: import("@playwright/test").Page, plan: unknown) {
  await page.route("**/api/transcribe", (r) => r.fulfill({ json: { transcript: "", transcriptTurns: [] } }));
  await page.route("**/api/plan", (r) =>
    r.fulfill({ contentType: "application/x-ndjson", body: [{ state: "running", step: "planning" }, { state: "done", plan }].map((l) => JSON.stringify(l)).join("\n") + "\n" }),
  );
  await page.addInitScript(() => {
    window.localStorage.setItem("sightwork:test-code", "stub-code");
    window.localStorage.setItem("sightwork:location", JSON.stringify({ city: "Sebring", state: "FL" }));
  });
}

test("the cost card sends the range, the biggest steps and the assumptions", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await stubPlan(page, costedPlan());
  await page.goto("/start?runner=api");
  await page.getByTestId("choose-video-input").setInputFiles(WALKTHROUGH);
  await page.getByRole("button", { name: "Make my work plan" }).click();
  const card = page.locator("#cost");
  const button = card.getByTestId("send-cost");
  await expect(button).toBeVisible({ timeout: 30_000 });
  await expect(button).toHaveAccessibleName("Send the cost");
  await button.click();
  await expect(card.getByRole("status")).toHaveText(/Copied/);
  const text = await page.evaluate(() => navigator.clipboard.readText());
  expect(text).toContain("\n$1,181–$2,643 for Sebring, FL\n");
  expect(text).toContain("Rough estimate, not a quote. Labor: volunteer and contractor.");
  expect(text).toMatch(/Biggest steps:\n- Step \d+, /);
  expect(text).toContain("- Mid-grade materials");
  expect(text).toContain("Get quotes before you commit to the spend.");
  expect(text).toContain("Made with SightWork");
  expect(text).not.toContain("Example plan");

  for (const width of [375, 768, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    // The cost section at the top, so no control from the section above sits half under the sticky chips while axe runs.
    await card.evaluate((el) => el.scrollIntoView({ block: "start" }));
    await expect(button).toBeInViewport();
    await expectNoSideScroll(page);
    await expectNoAxeViolations(page, `send cost ${width}`);
  }

  await page.emulateMedia({ media: "print" });
  await expect(button).toBeHidden();
});

test("no cost range, no button", async ({ page }) => {
  await page.goto("/start?view=example&ex=kitchen");
  await expect(page.getByTestId("send-counts")).toBeVisible();
  await expect(page.getByTestId("send-cost")).toHaveCount(0);
});
