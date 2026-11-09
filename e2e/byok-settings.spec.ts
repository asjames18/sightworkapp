import { test, expect, expectNoAxeViolations, expectNoSideScroll } from "./helpers";

// /api stays blocked (helpers.ts) and console errors fail the test. The e2e build turns the flag on.
test.beforeEach(async ({ apiCalls, pageErrors }) => {
  void apiCalls;
  void pageErrors;
});

const KEY = "LLM_e2eFakeKey_0123456789abcdefghijklmnop";

test("own-key settings save, mask and forget the key, and never send it anywhere", async ({ page }) => {
  const seen: string[] = [];
  page.on("request", (r) => seen.push(`${r.url()} ${r.postData() ?? ""}`));

  for (const width of [375, 768, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto("/settings");
    await expect(page.getByRole("heading", { name: "Use your own Meta API key" })).toBeVisible();
    await expect(page.getByText("never sent to SightWork's servers", { exact: false })).toBeVisible();
    await expectNoSideScroll(page);
    await expectNoAxeViolations(page, `settings empty ${width}`);

    // A bad paste gets a plain reason and nothing is saved.
    await page.getByTestId("byok-input").fill("too short");
    await page.getByTestId("byok-save").click();
    await expect(page.getByTestId("byok-error")).toBeVisible();
    await expect(page.getByTestId("byok-input")).toHaveAttribute("aria-invalid", "true");
    expect(await page.evaluate(() => localStorage.getItem("sightwork:byok:meta:v1"))).toBeNull();

    // A good paste (with a Bearer prefix from a curl line) is tidied, saved and shown masked.
    await page.getByTestId("byok-input").fill(`Bearer ${KEY}`);
    await page.getByTestId("byok-save").click();
    await expect(page.getByTestId("byok-masked")).toHaveText("LLM_••••••••mnop");
    await expect(page.getByTestId("byok-status")).toHaveText("Key saved in this browser.");
    expect(await page.evaluate(() => localStorage.getItem("sightwork:byok:meta:v1"))).toBe(KEY);
    await expect(page.locator("body")).not.toContainText(KEY);
    await expectNoSideScroll(page);
    await expectNoAxeViolations(page, `settings saved ${width}`);

    // It survives a reload, then Forget key removes it.
    await page.reload();
    await expect(page.getByTestId("byok-masked")).toHaveText("LLM_••••••••mnop");
    await page.getByTestId("byok-forget").click();
    await expect(page.getByTestId("byok-input")).toBeVisible();
    await expect(page.getByTestId("byok-status")).toContainText("Key forgotten");
    expect(await page.evaluate(() => localStorage.getItem("sightwork:byok:meta:v1"))).toBeNull();
  }

  expect(seen.filter((s) => s.includes(KEY)), "the key must never be in a request").toEqual([]);
});
