import { test, expect, expectNoAxeViolations, expectNoSideScroll } from "./helpers";
import type { Page } from "@playwright/test";

/**
 * Takes recorded in SightWork's camera are kept on this device the moment recording stops, apart from
 * the upload, with a Save video button on the take card and a "Your saved takes" list on the start
 * screen. The fake camera records a short take; no request ever reaches /api.
 */
test.beforeEach(async ({ apiCalls, pageErrors, context }) => {
  void apiCalls;
  void pageErrors;
  await context.grantPermissions(["camera", "microphone"]);
});

const NAME = /walkthrough-\d{4}-\d{2}-\d{2}-\d{4}\.(webm|mp4)/;

async function recordTake(page: Page) {
  await page.getByRole("button", { name: "Record a walkthrough" }).click();
  const cam = page.getByRole("group", { name: "Camera" });
  await expect(cam).toHaveAttribute("data-phase", "ready");
  await cam.getByRole("button", { name: "Start recording" }).click();
  await expect(cam).toHaveAttribute("data-phase", "recording");
  await page.waitForTimeout(2000);
  await cam.getByRole("button", { name: "Stop recording" }).click();
  const card = page.getByRole("group", { name: "Your walkthrough" });
  await expect(card).toContainText(NAME);
  return card;
}

for (const width of [375, 768, 1280]) {
  test(`saved takes: kept on stop, Save video downloads, listed on the start screen (${width} px)`, async ({ page }) => {
    // A computer-style browser: no share sheet, so Save video downloads.
    await page.addInitScript(() => {
      const mm = window.matchMedia.bind(window);
      window.matchMedia = (q: string) => (q.includes("pointer: coarse") ? ({ ...mm(q), matches: false, media: q } as MediaQueryList) : mm(q));
    });
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/start");
    await expect(page.getByTestId("saved-takes")).toHaveCount(0);
    const card = await recordTake(page);
    const box = card.getByTestId("save-take");
    await expect(box).toContainText("Saved in this browser. Tap Save video to download it.");
    await expectNoSideScroll(page);
    await expectNoAxeViolations(page, `take card with Save video (${width} px)`);

    const name = (await card.textContent())!.match(NAME)![0];
    const [download] = await Promise.all([page.waitForEvent("download"), box.getByRole("button", { name: "Save video" }).click()]);
    expect(download.suggestedFilename()).toBe(name);
    await expect(box.getByRole("status")).toHaveText("Downloaded. Look in your Downloads folder.");

    await page.emulateMedia({ media: "print" });
    await expect(box).toBeHidden();
    await page.emulateMedia({ media: "screen" });

    // Later: the start screen lists it, with Save video, Use and Remove.
    await page.goto("/start");
    const list = page.getByTestId("saved-takes");
    await expect(list.getByRole("heading", { name: "Your saved takes" })).toBeVisible();
    await expect(list.getByRole("listitem")).toHaveCount(1);
    await expect(list).toContainText(name);
    await expectNoSideScroll(page);
    await expectNoAxeViolations(page, `saved takes list (${width} px)`);
    const [again] = await Promise.all([page.waitForEvent("download"), list.getByRole("button", { name: `Save video ${name}` }).click()]);
    expect(again.suggestedFilename()).toBe(name);
    await page.emulateMedia({ media: "print" });
    await expect(list).toBeHidden();
    await page.emulateMedia({ media: "screen" });

    await list.getByRole("button", { name: `Use ${name} for a new plan` }).click();
    const reused = page.getByRole("group", { name: "Your walkthrough" });
    await expect(reused).toContainText(name);
    await expect(reused.getByTestId("save-take")).toHaveCount(0);

    await page.goto("/start");
    await page.getByRole("button", { name: new RegExp(`^Remove ${name.replace(/\./g, "\\.")}`) }).click();
    // The list empties, with Undo on offer until the next tap; a reload clears it for good.
    await expect(page.getByTestId("saved-takes").getByRole("listitem")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^Undo: put/ })).toBeVisible();
    await page.reload();
    await expect(page.getByTestId("saved-takes")).toHaveCount(0);
  });
}

test("saved takes: on a phone, Save video opens the share sheet with the video", async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as { __shared: { name: string; type: string; size: number }[] };
    w.__shared = [];
    const mm = window.matchMedia.bind(window);
    window.matchMedia = (q: string) => (q.includes("pointer: coarse") ? ({ ...mm(q), matches: true, media: q } as MediaQueryList) : mm(q));
    Object.defineProperty(navigator, "canShare", { configurable: true, value: (d: { files?: File[] }) => Boolean(d?.files?.length) });
    Object.defineProperty(navigator, "share", {
      configurable: true,
      value: async (d: { files?: File[] }) => {
        for (const f of d.files ?? []) w.__shared.push({ name: f.name, type: f.type, size: f.size });
      },
    });
  });
  await page.goto("/start");
  const card = await recordTake(page);
  const box = card.getByTestId("save-take");
  await expect(box).toContainText("Saved on this phone. Tap Save video to keep it in Photos.");
  await box.getByRole("button", { name: "Save video" }).click();
  await expect(box.getByRole("status")).toHaveText("Done.");
  const shared = await page.evaluate(() => (window as unknown as { __shared: { name: string; size: number }[] }).__shared);
  expect(shared).toHaveLength(1);
  expect(shared[0].name).toMatch(NAME);
  expect(shared[0].size).toBeGreaterThan(0);
});

test("saved takes: with storage blocked, recording and the take card still work", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "indexedDB", {
      configurable: true,
      get() {
        throw new Error("blocked");
      },
    });
  });
  await page.goto("/start");
  const card = await recordTake(page);
  await expect(card.getByTestId("save-take")).toContainText("Tap Save video to");
  await expect(card.getByTestId("save-take")).not.toContainText("Saved");
  await expect(card.getByRole("button", { name: "Make my work plan" })).toBeVisible();
  await page.goto("/start");
  await expect(page.getByTestId("saved-takes")).toHaveCount(0);
});
