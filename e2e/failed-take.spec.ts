import { test, expect, WALKTHROUGH, expectNoAxeViolations, expectNoSideScroll } from "./helpers";
import type { Page } from "@playwright/test";

/**
 * A real run that stops on a take recorded in SightWork's camera says the video is still kept on this
 * device, with a Save video button. A video picked from files gets no such line. /api stays blocked
 * (helpers.ts) except the stubbed routes below.
 */
test.beforeEach(async ({ context }) => {
  await context.grantPermissions(["camera", "microphone"]);
});

async function stubFailedRun(page: Page) {
  await page.route("**/api/transcribe", (r) => r.fulfill({ json: { transcript: "", transcriptTurns: [] } }));
  await page.route("**/api/plan", (r) =>
    r.fulfill({
      contentType: "application/x-ndjson",
      body: JSON.stringify({ state: "failed", step: "comparing", message: "Stub stop for the test." }) + "\n",
    }),
  );
  await page.addInitScript(() => {
    window.localStorage.setItem("sightwork:test-code", "stub-code");
    window.localStorage.setItem("sightwork:location", JSON.stringify({ city: "Atlanta", state: "GA" }));
    const mm = window.matchMedia.bind(window);
    window.matchMedia = (q: string) => (q.includes("pointer: coarse") ? ({ ...mm(q), matches: false, media: q } as MediaQueryList) : mm(q));
  });
}

test("a stopped run on a recorded take says the video is still saved, with Save video", async ({ page }) => {
  await stubFailedRun(page);
  await page.goto("/start?runner=api");
  await page.getByRole("button", { name: "Record a walkthrough" }).click();
  const cam = page.getByRole("group", { name: "Camera" });
  await expect(cam).toHaveAttribute("data-phase", "ready");
  await cam.getByRole("button", { name: "Start recording" }).click();
  await expect(cam).toHaveAttribute("data-phase", "recording");
  // Long enough to pass the length check (a few seconds is blocked).
  await page.waitForTimeout(6300);
  await cam.getByRole("button", { name: "Stop recording" }).click();
  const card = page.getByRole("group", { name: "Your walkthrough" });
  await expect(card.getByTestId("save-take")).toBeVisible();
  const name = (await card.textContent())!.match(/walkthrough-\d{4}-\d{2}-\d{2}-\d{4}\.(webm|mp4)/)![0];

  const make = page.getByRole("button", { name: "Make my work plan" });
  await expect(make).toBeEnabled();
  await make.click();
  const alert = page.getByRole("alert").filter({ hasText: "Stub stop for the test." });
  await expect(alert).toBeVisible({ timeout: 30_000 });
  const note = alert.getByTestId("failed-take");
  await expect(note).toContainText("Your video is still saved in this browser. Tap Save video to download it, then try again.");
  for (const width of [375, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(note).toBeVisible();
    await expectNoSideScroll(page);
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  await expectNoAxeViolations(page, "stopped run on a recorded take");

  const [download] = await Promise.all([page.waitForEvent("download"), note.getByRole("button", { name: "Save video" }).click()]);
  expect(download.suggestedFilename()).toBe(name);

  await page.emulateMedia({ media: "print" });
  await expect(note).toBeHidden();
  await page.emulateMedia({ media: "screen" });
});

test("a stopped run on a picked video shows no saved-take line", async ({ page }) => {
  await stubFailedRun(page);
  await page.goto("/start?runner=api");
  await page.getByTestId("choose-video-input").setInputFiles(WALKTHROUGH);
  await page.getByRole("button", { name: "Make my work plan" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Stub stop for the test." })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("failed-take")).toHaveCount(0);
});
