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
  const emails: string[] = [];
  await page.route("**/api/billing/checkout", async (route) => {
    const sent = route.request().postDataJSON() as { plan: string; email: string };
    asked.push(sent.plan);
    emails.push(sent.email);
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

  await page.getByTestId("checkout-email").fill("buyer@example.com");
  await page.getByTestId("buy-ministry").click();
  await expect(page).toHaveURL(FAKE_CHECKOUT);
  await page.goto("/pricing");
  await page.getByTestId("checkout-email").fill("buyer@example.com");
  await page.getByTestId("buy-pack5").click();
  await expect(page).toHaveURL(FAKE_CHECKOUT);
  expect(asked).toEqual(["ministry-yearly", "pack5"]);
  expect(emails).toEqual(["buyer@example.com", "buyer@example.com"]);
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
    await page.getByTestId("checkout-email").fill("buyer@example.com");
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
    data: { plan: "single", email: "buyer@example.com" },
  });
  expect(r.status()).toBe(503);
  expect(await r.json()).toEqual({
    error:
      "Checkout isn't available right now. Please try again in a few minutes.",
  });
  const bad = await request.post("/api/billing/checkout", {
    data: { plan: "nope", email: "buyer@example.com" },
  });
  expect(bad.status()).toBe(400);
  // Every checkout needs a valid email, checked on the server as well as the page.
  for (const data of [{ plan: "single" }, { plan: "single", email: "not-an-email" }]) {
    const noEmail = await request.post("/api/billing/checkout", { data });
    expect(noEmail.status()).toBe(400);
    expect(await noEmail.json()).toEqual({
      error: "Enter a valid email address so we can send your access code.",
    });
  }
  // Other API routes stay gated; plan runs need a paid access code while billing is on.
  expect((await request.post("/api/other", { data: {} })).status()).toBe(401);
  expect((await request.post("/api/plan", { data: {} })).status()).toBe(402);
});

test("checkout stays closed until a valid email is entered, with an accessible error", async ({
  page,
}) => {
  let calls = 0;
  await page.route("**/api/billing/checkout", async (route) => {
    calls++;
    await route.fulfill({ json: { url: FAKE_CHECKOUT } });
  });
  await page.route("https://checkout.stripe.com/**", (route) =>
    route.fulfill({ contentType: "text/html", body: "<title>Stripe</title>ok" }),
  );
  await page.goto("/pricing");
  const email = page.getByLabel("Email (required)");
  await expect(email).toHaveAttribute("required", "");
  await expect(email).toHaveAttribute("type", "email");
  for (const id of ["buy-single", "buy-pack5", "buy-church", "buy-ministry", "buy-multisite"]) {
    await expect(page.getByTestId(id)).toBeDisabled();
  }

  await email.fill("not-an-email");
  await email.blur();
  await expect(page.getByTestId("checkout-email-error")).toHaveText(
    "Enter a valid email address, like name@example.com.",
  );
  await expect(email).toHaveAttribute("aria-invalid", "true");
  await expect(email).toHaveAttribute("aria-describedby", /checkout-email-error/);
  await expect(page.getByTestId("buy-single")).toBeDisabled();
  await expectNoAxeViolations(page, "pricing email error");

  await email.fill("Buyer@Example.com");
  await expect(page.getByTestId("checkout-email-error")).toHaveText("");
  await expect(email).toHaveAttribute("aria-invalid", "false");
  await expect(page.getByTestId("buy-single")).toBeEnabled();
  expect(calls).toBe(0);
  const req = page.waitForRequest("**/api/billing/checkout");
  await page.getByTestId("buy-single").click();
  expect((await req).postDataJSON()).toEqual({ plan: "single", email: "Buyer@Example.com" });
  await expect(page).toHaveURL(FAKE_CHECKOUT);
});
