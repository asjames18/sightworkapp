import { readFile } from "node:fs/promises";
import { test, expect, expectNoAxeViolations, expectNoSideScroll } from "./helpers";

// /api stays blocked (helpers.ts) and console errors fail the test; the stored sanctuary run needs no model.
test.beforeEach(async ({ apiCalls, pageErrors }) => {
  void apiCalls;
  void pageErrors;
});

test("work order opens with who does the work: paid trades, then volunteers, and a total", async ({ page }) => {
  await page.goto("/start?view=example&ex=sanctuary");
  const steps = page.locator("#steps");
  await expect(steps.getByRole("heading", { name: "Do the work in this order" })).toBeVisible();

  const card = steps.getByTestId("crew-summary");
  await expect(card.getByRole("heading", { name: "Who does the work" })).toBeVisible();
  const rows = card.getByTestId("crew-row");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText("Paid");
  await expect(rows.nth(0)).toContainText("Painter");
  await expect(rows.nth(0)).toContainText("Step 5, about 3–5 h");
  await expect(rows.nth(1)).toContainText("Free");
  await expect(rows.nth(1)).toContainText("Volunteers");
  await expect(rows.nth(1)).toContainText("Steps 1, 2, 3, 4 and 6, about 4–7.5 h");
  await expect(card.getByTestId("crew-total")).toHaveText("All 6 steps: about 7–12.5 h of work in total, before any waiting between steps.");

  await card.scrollIntoViewIfNeeded();
  await expectNoSideScroll(page);
  await expectNoAxeViolations(page, "crew summary");
});

test("each crew row sends just that crew's steps and materials", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  for (const width of [375, 768, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto("/start?view=example&ex=sanctuary");
    const card = page.locator("#steps").getByTestId("crew-summary");
    await card.scrollIntoViewIfNeeded();
    const send = card.getByRole("button", { name: "Send Painter their steps" });
    await expect(send).toBeVisible();
    await expect(card.getByTestId("crew-send")).toHaveCount(2);
    await send.click();
    await expect(card.getByText("Copied. Paste it into a text.")).toBeVisible();
    const text = await page.evaluate(() => navigator.clipboard.readText());
    expect(text).toMatch(/^Painter: your part of the work plan for /);
    expect(text).toContain("Step 5. ");
    expect(text).toMatch(/\n {3}When: (Mon|Tue|Wed|Thu|Fri), \w{3} \d{1,2}, \d{1,2}(:\d{2})? (AM|PM) to /);
    expect(text).toContain("this list is step 5 only.");
    expect(text).toContain("Made with SightWork");
    await expectNoSideScroll(page);
    await page.evaluate(() => window.scrollTo(0, 0));
    await expectNoAxeViolations(page, `crew send ${width}`);
  }
});

test("each crew row downloads a calendar of just that crew's steps, at the full calendar's times", async ({ page }) => {
  for (const width of [375, 768, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto("/start?view=example&ex=sanctuary");
    const card = page.locator("#steps").getByTestId("crew-summary");
    await card.scrollIntoViewIfNeeded();
    await expect(card.getByTestId("crew-calendar")).toHaveCount(2);
    const btn = card.getByRole("button", { name: "Calendar file of Painter's steps" });
    const box = await btn.boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(44);
    const [crewDl] = await Promise.all([page.waitForEvent("download"), btn.click()]);
    expect(crewDl.suggestedFilename()).toMatch(/^sightwork-painter-steps-\d{4}-\d{2}-\d{2}\.ics$/);
    const crewIcs = (await readFile((await crewDl.path())!, "utf8")).replace(/\r\n /g, "");
    expect(crewIcs).toMatch(/X-WR-CALNAME:SightWork: .*\\, Painter\r\n/);
    expect(crewIcs).toMatch(/SUMMARY:Step 5: /);
    expect(crewIcs).not.toMatch(/SUMMARY:Step 3: /);
    await expect(card.getByText("Saved. Send the file to them.")).toBeVisible();

    const [fullDl] = await Promise.all([page.waitForEvent("download"), page.getByTestId("step-calendar").getByRole("button", { name: "Add to calendar" }).click()]);
    const fullIcs = (await readFile((await fullDl.path())!, "utf8")).replace(/\r\n /g, "");
    const start = (ics: string) => ics.match(/step-5-1@[\s\S]*?DTSTART:(\d{8}T\d{6})/)?.[1];
    expect(start(crewIcs)).toBeTruthy();
    expect(start(crewIcs)).toBe(start(fullIcs));

    await card.scrollIntoViewIfNeeded();
    await expectNoSideScroll(page);
    await page.evaluate(() => window.scrollTo(0, 0));
    await expectNoAxeViolations(page, `crew calendar ${width}`);
  }
});
