import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end browser checks (`npm run e2e`). Not part of `npm run build` or `npm test`.
 *
 * Runs against a local production build with the mock runner and every model key blanked, so nothing
 * here can reach Meta or Baseten; the specs also abort any browser request to /api/** and fail if one
 * is made. Set E2E_BASE_URL to test an already running server instead (no build, no server started).
 * Browser: Playwright's Chromium (`npx playwright install chromium` once), or point E2E_CHROME_PATH
 * at an installed Chrome.
 */
const PORT = Number(process.env.E2E_PORT ?? 3217);
const external = process.env.E2E_BASE_URL;
const baseURL = external ?? `http://127.0.0.1:${PORT}`;
const executablePath = process.env.E2E_CHROME_PATH || undefined;

export default defineConfig({
  testDir: "e2e",
  outputDir: "e2e/.results",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"]],
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    // Fake camera + mic with auto-accepted permission, for the in-page recorder check (e2e/recorder.spec.ts).
    launchOptions: {
      ...(executablePath ? { executablePath } : {}),
      args: [
        ...(executablePath ? ["--no-sandbox"] : []),
        "--use-fake-device-for-media-stream",
        "--use-fake-ui-for-media-stream",
      ],
    },
  },
  projects: [
    {
      name: "phone-390",
      use: { ...devices["Desktop Chrome"], viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
    },
    {
      name: "desktop-1440",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
  ],
  webServer: external
    ? undefined
    : {
        command: `${process.env.E2E_SKIP_BUILD ? "" : "npm run build && "}npx next start -H 127.0.0.1 -p ${PORT}`,
        url: `${baseURL}/start`,
        timeout: 240_000,
        reuseExistingServer: false,
        // Set (even empty) values win over .env.local, so a local key file can't turn on real runs here.
        env: {
          NEXT_PUBLIC_SIGHTWORK_RUNNER: "mock",
          NEXT_PUBLIC_SIGHTWORK_BYOK: "on",
          SIGHTWORK_TEST_CODE: "",
          META_API_KEY: "",
          MODEL_API_KEY: "",
          BASETEN_API_KEY: "",
          SIGHTWORK_BILLING: "on",
          STRIPE_SECRET_KEY: "",
        },
      },
});
