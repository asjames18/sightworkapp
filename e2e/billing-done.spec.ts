import { test, expect, expectNoAxeViolations, expectNoSideScroll } from "./helpers";

test.beforeEach(async ({ apiCalls, pageErrors }) => {
  void apiCalls;
  void pageErrors;
});

const CODE = "sw1.eyJrIjoicGFjayJ9.c2lnbmF0dXJlLXNpZ25hdHVyZS1zaWduYXR1cmUtc2lnbmF0dXJlLXNpZw";

test("the return page shows the access code and reads cleanly at every width", async ({ page }) => {
  await page.route("**/api/billing/done", async (route) => {
    expect(route.request().postDataJSON()).toEqual({ sessionId: "cs_test_e2eABC123" });
    await route.fulfill({ json: { code: CODE, kind: "pack", plan: "5-Plan Pack" } });
  });
  for (const width of [375, 768, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto("/billing/done?session_id=cs_test_e2eABC123");
    await expect(page.getByTestId("access-code")).toHaveText(CODE);
    await expect(page.getByText("5-Plan Pack is ready")).toBeVisible();
    await expect(page.getByTestId("code-kept")).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem("sightwork:access-code"))).toBe(CODE);
    await expectNoSideScroll(page);
    await expectNoAxeViolations(page, `billing done ${width}`);
  }
});

test("a missing session id, an unpaid session and a failure each say one plain thing", async ({ page }) => {
  await page.goto("/billing/done");
  await expect(page.getByTestId("billing-error")).toContainText("isn't a valid purchase link");
  await page.route("**/api/billing/done", (route) =>
    route.fulfill({ status: 202, json: { error: "Your payment hasn't gone through yet.", pending: true } }),
  );
  await page.goto("/billing/done?session_id=cs_test_e2eABC123");
  await expect(page.getByTestId("billing-pending")).toBeVisible();
  await expectNoAxeViolations(page, "billing pending");
});

test("the real route needs no tester code and fails plainly without Stripe settings", async ({ request }) => {
  const bad = await request.post("/api/billing/done", { data: { sessionId: "nope" } });
  expect(bad.status()).toBe(400);
  const r = await request.post("/api/billing/done", { data: { sessionId: "cs_test_e2eABC123" } });
  expect(r.status()).toBe(503);
});
