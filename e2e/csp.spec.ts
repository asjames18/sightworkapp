import { test, expect } from "./helpers";

// The e2e build has own-key mode on, so the policy allows this site plus the Meta API host only.
// Any CSP violation logs a console error, which helpers.ts turns into a failure on every spec.
test.beforeEach(async ({ apiCalls, pageErrors }) => {
  void apiCalls;
  void pageErrors;
});

for (const path of ["/", "/start", "/start?view=example", "/settings", "/credits"]) {
  test(`strict CSP is sent on ${path} and the page runs under it`, async ({ page }) => {
    const res = await page.goto(path);
    const csp = res?.headers()["content-security-policy"] ?? "";
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("connect-src 'self' blob: data: https://api.meta.ai");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain("unsafe-eval");
    await expect(page.locator("main").first()).toBeVisible();
  });
}

test.describe("blocked host", () => {
  // The browser logs the refused fetch as a CSP console error; that one line is the point of this test.
  test.use({ expectedConsoleErrors: [/Content Security Policy|Failed to fetch/i] });
  test("the browser cannot reach a host the policy doesn't list", async ({ page }) => {
  await page.goto("/settings");
  const blocked = await page.evaluate(async () => {
    try {
      await fetch("https://example.com/", { mode: "no-cors" });
      return false;
    } catch {
      return true;
    }
  });
  expect(blocked).toBe(true);
});
});
