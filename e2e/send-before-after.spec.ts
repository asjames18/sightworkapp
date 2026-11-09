import { test, expect, expectNoAxeViolations, expectNoSideScroll } from "./helpers";

// "Send before and after" under the Before and after slider: one labeled picture with the real frame and the
// AI concept. A phone shares it through the share sheet (stubbed here to record what it was given); a computer
// downloads it.
const SANCTUARY = "/start?view=example&ex=sanctuary";

type Shared = { title: string; text: string; files: { name: string; type: string; size: number; width: number; height: number }[] };

test.describe("on a phone", () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 375, height: 800 } });

  test.beforeEach(async ({ page }) => {
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

  test("shares one side-by-side JPEG of the before frame and the AI concept, with the text", async ({ page }) => {
    await page.goto(SANCTUARY);
    const button = page.getByRole("button", { name: "Send before and after" });
    await expect(button).toBeVisible();
    await page.waitForTimeout(2000);
    await button.click();
    await expect.poll(() => page.evaluate(() => (window as unknown as { __shared: unknown[] }).__shared.length)).toBe(1);
    const [shared] = (await page.evaluate(() => (window as unknown as { __shared: unknown[] }).__shared)) as Shared[];
    expect(shared.title).toMatch(/^Before and after/);
    expect(shared.files).toHaveLength(1);
    const file = shared.files[0];
    expect(file.type).toBe("image/jpeg");
    expect(file.name).toMatch(/^sightwork-before-after(-[a-z0-9-]+)?\.jpg$/);
    expect(file.size).toBeGreaterThan(10_000);
    // The real run was filmed upright, so the two panels stack (before on top) above the caption strip; never above the cap.
    expect(file.height).toBeGreaterThan(file.width);
    expect(Math.max(file.width, file.height)).toBeLessThanOrEqual(1280);
    expect(shared.text).toContain("Before: a frame from the walkthrough video.");
    expect(shared.text).toContain("After: ");
    expect(shared.text).toContain("From SightWork's example plan.");
    expect(shared.text.trim().endsWith("sightwork.vercel.app")).toBe(true);
    await expectNoSideScroll(page);
  });
});

test.describe("on a computer", () => {
  test("downloads the picture and says so", async ({ page, hasTouch }) => {
    test.skip(hasTouch, "touch projects share instead of downloading");
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(SANCTUARY);
    const button = page.getByRole("button", { name: "Send before and after" });
    await button.scrollIntoViewIfNeeded();
    const [download] = await Promise.all([page.waitForEvent("download"), button.click()]);
    expect(download.suggestedFilename()).toMatch(/^sightwork-before-after(-[a-z0-9-]+)?\.jpg$/);
    await expect(page.getByText("Saved the picture. Attach it to a message or email.")).toBeVisible();
  });

  for (const width of [375, 768, 1280]) {
    test(`the button fits and passes axe at ${width} px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(SANCTUARY);
      const button = page.getByRole("button", { name: "Send before and after" });
      await button.scrollIntoViewIfNeeded();
      await expect(button).toBeVisible();
      const box = await button.boundingBox();
      expect(box!.height).toBeGreaterThanOrEqual(44);
      await expectNoSideScroll(page);
      await expectNoAxeViolations(page, `send before and after ${width}`);
    });
  }

  test("is hidden in print", async ({ page }) => {
    await page.goto(SANCTUARY);
    await page.emulateMedia({ media: "print" });
    await expect(page.getByRole("button", { name: "Send before and after" })).toBeHidden();
  });
});
