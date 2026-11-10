import {
  test,
  expect,
  expectNoAxeViolations,
  expectNoSideScroll,
} from "./helpers";

// The e2e build turns billing on with no Stripe key, so the real route answers 503 and never reaches Stripe.
test.beforeEach(async ({ apiCalls, pageErrors }) => {
  void apiCalls;
  void pageErrors;
});

const FAKE_CHECKOUT = "https://checkout.stripe.com/c/pay/cs_test_e2e";

test("pricing reads cleanly at every width and sends each plan to checkout", async ({
  page,
}) => {
  const asked: string[] = [];
  await page.route("**/api/billing/checkout", async (route) => {
    asked.push((route.request().postDataJSON() as { plan: string }).plan);
    await route.fulfill({ json: { url: FAKE_CHECKOUT } });
  });
  await page.route("https://checkout.stripe.com/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<title>Stripe</title>ok",
    }),
  );

  for (const width of [375, 768, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto("/pricing");
    await expect(
      page.getByRole("heading", { level: 1, name: "Pricing" }),
    ).toBeVisible();
    await expect(page.getByTestId("period-monthly")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expectNoSideScroll(page);
    await expectNoAxeViolations(page, `pricing monthly ${width}`);
    await page.getByTestId("period-yearly").click();
    await expect(page.getByText("NONPROFIT25", { exact: false })).toBeVisible();
    await expect(page.getByText("$1,290", { exact: false })).toBeVisible();
    await expectNoAxeViolations(page, `pricing yearly ${width}`);
  }

  await page.getByTestId("buy-ministry").click();
  await expect(page).toHaveURL(FAKE_CHECKOUT);
  await page.goto("/pricing");
  await page.getByTestId("buy-pack5").click();
  await expect(page).toHaveURL(FAKE_CHECKOUT);
  expect(asked).toEqual(["ministry-yearly", "pack5"]);
});

test.describe("checkout errors", () => {
  test.use({ expectedConsoleErrors: [/status of 503/] });

  test("a checkout that can't open shows one plain error and lets the buyer retry", async ({
    page,
  }) => {
    await page.route("**/api/billing/checkout", (route) =>
      route.fulfill({
        status: 503,
        json: {
          error:
            "Checkout isn't available right now. Please try again in a few minutes.",
        },
      }),
    );
    await page.goto("/pricing");
    await page.getByTestId("buy-single").click();
    await expect(page.getByTestId("checkout-error")).toHaveText(
      "Checkout isn't available right now. Please try again in a few minutes.",
    );
    await expect(page.getByTestId("buy-single")).toBeEnabled();
  });
});

test("the real checkout route skips the tester-code gate and fails plainly without a Stripe key", async ({
  request,
}) => {
  const r = await request.post("/api/billing/checkout", {
    data: { plan: "single" },
  });
  expect(r.status()).toBe(503);
  expect(await r.json()).toEqual({
    error:
      "Checkout isn't available right now. Please try again in a few minutes.",
  });
  const bad = await request.post("/api/billing/checkout", {
    data: { plan: "nope" },
  });
  expect(bad.status()).toBe(400);
  // Other API routes stay gated.
  expect((await request.post("/api/plan", { data: {} })).status()).toBe(401);
});
