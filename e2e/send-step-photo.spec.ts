import { test, expect, expectNoAxeViolations, expectNoSideScroll } from "./helpers";

// A phone whose share sheet takes files: "Send this step" sends the outlined proof photo of the first problem the
// step fixes, with the step text. navigator.share is stubbed to record what it was given.
test.use({ hasTouch: true, isMobile: true, viewport: { width: 375, height: 800 } });

test.beforeEach(async ({ page, apiCalls, pageErrors }) => {
  void apiCalls;
  void pageErrors;
  await page.addInitScript(() => {
    const w = window as unknown as { __shared: unknown[] };
    w.__shared = [];
    Object.defineProperty(navigator, "canShare", { configurable: true, value: () => true });
    Object.defineProperty(navigator, "share", {
      configurable: true,
      value: async (data: { title?: string; text?: string; files?: File[] }) => {
        const files = await Promise.all(
          (data.files ?? []).map(async (f) => {
            const bmp = await createImageBitmap(f);
            return { name: f.name, type: f.type, size: f.size, width: bmp.width, height: bmp.height };
          }),
        );
        w.__shared.push({ title: data.title, text: data.text, files });
      },
    });
  });
});

type Shared = { title: string; text: string; files: { name: string; type: string; size: number; width: number; height: number }[] };
const shared = (page: import("@playwright/test").Page) =>
  page.evaluate(() => (window as unknown as { __shared: unknown[] }).__shared) as Promise<Shared[]>;

test("Send this step attaches the outlined photo of the problem it fixes", async ({ page }) => {
  await page.goto("/start?view=example&ex=kitchen");
  const step = page.locator('li[id^="step-"]').first();
  await expect(step).toBeVisible();
  await page.waitForTimeout(2500);
  await step.getByTestId("send-step").evaluate((el) => el.scrollIntoView({ block: "center" }));
  await step.getByTestId("send-step").click();
  await expect.poll(async () => (await shared(page)).length).toBe(1);
  const [s] = await shared(page);
  expect(s.title).toMatch(/^Step 1/);
  expect(s.files).toHaveLength(1);
  expect(s.files[0].type).toBe("image/jpeg");
  expect(s.files[0].name).toMatch(/^sightwork-problem-\d+-[a-z0-9-]+\.jpg$/);
  expect(s.files[0].size).toBeGreaterThan(5_000);
  const rank = s.files[0].name.match(/problem-(\d+)/)![1];
  expect(s.text).toMatch(new RegExp(`Photo attached, (with problem #${rank} outlined|showing problem #${rank})\\.`));
  expect(s.text.indexOf("Photo attached")).toBeLessThan(s.text.indexOf("Made with SightWork"));
  await expectNoSideScroll(page);
});

test("the real sanctuary run's steps send photos at phone and tablet widths", async ({ page }) => {
  for (const width of [375, 768]) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto("/start/example/sanctuary");
    const steps = page.locator('li[id^="step-"]');
    await expect(steps.first()).toBeVisible();
    await page.waitForTimeout(2500);
    const btn = steps.first().getByTestId("send-step");
    await btn.evaluate((el) => el.scrollIntoView({ block: "center" }));
    await btn.click();
    await expect.poll(async () => (await shared(page)).length).toBe(1);
    const [s] = await shared(page);
    expect(s.files).toHaveLength(1);
    expect(s.files[0].name).toMatch(/^sightwork-problem-\d+-/);
    await expectNoSideScroll(page);
    await expectNoAxeViolations(page, `send step photo ${width}`);
  }
});
