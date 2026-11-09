import { test, expect, expectNoAxeViolations, expectNoSideScroll } from "./helpers";

// A phone whose share sheet takes files: "Send this problem" sends the proof photo, outlined, with the text.
// navigator.share is stubbed to record what it was given (the real sheet can't open in a headless browser).
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

test("Send this problem attaches the outlined proof photo on a phone", async ({ page }) => {
  await page.goto("/start?view=example&ex=kitchen");
  const card = page.locator('li[id^="problem-"]').first();
  await expect(card).toBeVisible();
  // Give the photo time to be drawn ahead of the tap.
  await page.waitForTimeout(2000);
  await card.getByTestId("send-problem").click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __shared: unknown[] }).__shared.length)).toBe(1);
  const [shared] = (await page.evaluate(() => (window as unknown as { __shared: unknown[] }).__shared)) as Shared[];
  expect(shared.title).toMatch(/^Problem #1: /);
  expect(shared.files).toHaveLength(1);
  const file = shared.files[0];
  expect(file.type).toBe("image/jpeg");
  expect(file.name).toMatch(/^sightwork-problem-1-[a-z0-9-]+\.jpg$/);
  expect(file.size).toBeGreaterThan(5_000);
  expect(file.width).toBeGreaterThan(300);
  expect(shared.text).toContain("Photo attached, with the problem outlined.");
  expect(shared.text.indexOf("Photo attached")).toBeLessThan(shared.text.indexOf("Made with SightWork"));
  await expectNoSideScroll(page);
});

test("the real sanctuary run's problems send their photos too, at phone and tablet widths", async ({ page }) => {
  for (const width of [375, 768]) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto("/start/example/sanctuary");
    const cards = page.locator('li[id^="problem-"]');
    await expect(cards.first()).toBeVisible();
    await page.waitForTimeout(2000);
    const second = cards.nth(1);
    await second.getByTestId("send-problem").evaluate((el) => el.scrollIntoView({ block: "center" }));
    await second.getByTestId("send-problem").click();
    await expect.poll(() => page.evaluate(() => (window as unknown as { __shared: unknown[] }).__shared.length)).toBe(1);
    const [shared] = (await page.evaluate(() => (window as unknown as { __shared: unknown[] }).__shared)) as Shared[];
    expect(shared.files).toHaveLength(1);
    expect(shared.files[0].name).toMatch(/^sightwork-problem-2-/);
    await expectNoSideScroll(page);
    await expectNoAxeViolations(page, `send problem photo ${width}`);
  }
});
