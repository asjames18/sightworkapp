import {
  test,
  expect,
  expectNoAxeViolations,
  expectNoSideScroll,
} from "./helpers";

const PORTAL = "https://billing.stripe.com/p/session/test_e2e";

test("account forms fit every width and pass accessibility checks", async ({
  page,
}) => {
  for (const width of [375, 768, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto("/pricing");
    await expect(
      page.getByRole("heading", { name: "Manage a subscription" }),
    ).toBeVisible();
    await expectNoSideScroll(page);
    await expectNoAxeViolations(page, `pricing account ${width}`);
  }
});

test("recover shows the plain answer and portal opens billing settings", async ({
  page,
}) => {
  const sent: unknown[] = [];
  await page.route("**/api/billing/recover", async (route) => {
    sent.push(route.request().postDataJSON());
    await route.fulfill({
      json: {
        ok: true,
        message: "If that email has a purchase, we just sent it.",
      },
    });
  });
  await page.route("**/api/billing/portal", async (route) => {
    sent.push(route.request().postDataJSON());
    await route.fulfill({ json: { url: PORTAL } });
  });
  await page.route("https://billing.stripe.com/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<title>Stripe</title>ok",
    }),
  );
  await page.goto("/pricing");
  await expect(page.getByTestId("recover-go")).toBeDisabled();
  await page.getByLabel("Email", { exact: true }).fill(" a@example.com ");
  await page.getByTestId("recover-go").click();
  await expect(page.getByTestId("recover-note")).toHaveText(
    "If that email has a purchase, we just sent it.",
  );
  await page.getByLabel("Access code", { exact: true }).fill("abc");
  await page.getByTestId("portal-go").click();
  await expect(page).toHaveURL(PORTAL);
  expect(sent).toEqual([{ email: "a@example.com" }, { code: "abc" }]);
});

test.describe("portal errors", () => {
  test.use({ expectedConsoleErrors: [/status of 400/] });
  test("a bad code shows one plain error", async ({ page }) => {
    await page.route("**/api/billing/portal", (route) =>
      route.fulfill({
        status: 400,
        json: { error: "That access code isn't valid." },
      }),
    );
    await page.goto("/pricing");
    await page.getByLabel("Access code", { exact: true }).fill("nope");
    await page.getByTestId("portal-go").click();
    await expect(page.getByTestId("portal-note")).toHaveText(
      "That access code isn't valid.",
    );
  });
});
