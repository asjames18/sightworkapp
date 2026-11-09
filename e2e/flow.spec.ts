import { test, expect, WALKTHROUGH, SHORT_CLIP, BLANK_CLIP, QUIET_NARRATION_CLIP, PHONE_MOV_SPATIAL_FIRST, expectNoAxeViolations, expectNoSideScroll } from "./helpers";

// Every test uses both fixtures, so /api stays blocked and console errors fail the test.
test.beforeEach(async ({ apiCalls, pageErrors }) => {
  void apiCalls;
  void pageErrors;
});

const UPLOAD_H1 = "Film a walkthrough. Get a work plan.";

test("landing opens the upload screen with the filming tips", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("h1").first()).toBeVisible();
  await expectNoAxeViolations(page, "landing");
  await page.getByRole("link", { name: "Film a walkthrough" }).first().click();
  await expect(page).toHaveURL(/\/start$/);
  await expect(page.getByRole("heading", { level: 1, name: UPLOAD_H1 })).toBeVisible();

  const tips = page.getByRole("region", { name: "How to film" });
  await expect(tips).toBeVisible();
  await expect(tips.getByRole("listitem")).toHaveCount(6);
  for (const t of ["Walk slowly", "Lights on", "Stay 3 to 6 feet from walls", "Cover each area once", "Name each area", "Point out problems"]) {
    await expect(tips.getByText(t, { exact: false })).toBeVisible();
  }
  await expect(tips).toContainText("1 to 2 feet");
  await expectNoSideScroll(page);
  await expectNoAxeViolations(page, "/start");
});

test("landing's example link opens the example plan", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: "See an example plan" }).first().click();
  await expect(page.getByRole("heading", { name: "Problems, worst first" })).toBeVisible();
  await expect(page.getByText(/^(Real run|Sample)$/).first()).toBeVisible();
  await expectNoSideScroll(page);
  await expectNoAxeViolations(page, "example plan");
});

test("an example card on /start opens its plan, and Make your own comes back", async ({ page }) => {
  await page.goto("/start");
  await page.getByRole("button", { name: /Warehouse floor/ }).click();
  await expect(page.getByRole("heading", { name: "Problems, worst first" })).toBeVisible();
  await expect(page.getByText("Sample", { exact: true }).first()).toBeVisible();
  await page.getByRole("button", { name: "Make your own" }).click();
  await expect(page.getByRole("heading", { level: 1, name: UPLOAD_H1 })).toBeVisible();
});

test("deep link /start?view=example renders the plan in the first HTML", async ({ page, request }) => {
  const html = await (await request.get("/start?view=example&ex=sanctuary")).text();
  expect(html).toContain("Problems, worst first");
  await page.goto("/start?view=example&ex=sanctuary");
  await expect(page.getByText("Real run", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "Problems, worst first" })).toBeVisible();
});

test("upload a video (mock runner): processing screen, then the plan", async ({ page }) => {
  await page.goto("/start");
  await page.getByTestId("choose-video-input").setInputFiles(WALKTHROUGH);
  const card = page.getByRole("group", { name: "Your walkthrough" });
  await expect(card).toContainText("walkthrough-6s.webm");
  await expect(card).toContainText("0:06");
  await expect(card).toContainText("your video stays on this device");
  const make = page.getByRole("button", { name: "Make my work plan" });
  await expect(make).toBeEnabled();
  await make.click();

  await expect(page.getByRole("heading", { level: 1, name: "Working on your plan" })).toBeVisible();
  await expect(page.getByRole("progressbar", { name: "Plan progress" })).toBeVisible();
  await expectNoAxeViolations(page, "processing");

  await expect(page.getByRole("heading", { name: "Problems, worst first" })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/your video .walkthrough-6s\.webm. was not sent anywhere/)).toBeVisible();
  await expectNoSideScroll(page);
  await expectNoAxeViolations(page, "plan after a mock run");
});

test("a clip under 5 seconds is blocked before anything runs", async ({ page }) => {
  await page.goto("/start");
  await page.getByTestId("choose-video-input").setInputFiles(SHORT_CLIP);
  await expect(page.getByRole("alert").filter({ hasText: "only a few seconds" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Make my work plan" })).toBeDisabled();
});

test("real-run mode without a tester code asks for it on the video card and sends nothing", async ({ page }) => {
  // City and state are saved here (e2e/city-region.spec.ts covers asking for them).
  await page.addInitScript(() => window.localStorage.setItem("sightwork:location", JSON.stringify({ city: "Sebring", state: "FL" })));
  await page.goto("/start?runner=api");
  const code = page.getByLabel("Tester code for real runs");
  await expect(code).toBeVisible();
  await expect(code).toHaveValue("");
  await expect(page.getByText("Real runs use paid model credits, so they need a code.")).toBeVisible();
  await expectNoAxeViolations(page, "/start?runner=api");

  await page.getByTestId("choose-video-input").setInputFiles(WALKTHROUGH);
  await expect(page.getByText("Frames and narration are sent to make your plan.")).toBeVisible();
  await page.getByRole("button", { name: "Make my work plan" }).click();
  // No run, no example plan: the code prompt opens on the same video card.
  const card = page.getByRole("group", { name: "Your walkthrough" });
  await expect(card.getByText("Enter the tester code to make a plan from this video.")).toBeVisible();
  await expect(card.getByLabel("Tester code for real runs")).toBeFocused();
  await expect(card).toContainText("walkthrough-6s.webm");
  await expect(page.getByRole("heading", { level: 1, name: "Working on your plan" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Problems, worst first" })).toHaveCount(0);
  await expectNoAxeViolations(page, "tester code prompt on the video card");
  // The apiCalls fixture then checks that no /api request left the browser.
});

/**
 * Stubs /api/transcribe and /api/plan in the browser (no server call, no model call) and records what the
 * page sent: the tester code header and how big the plan request was, which proves the user's own video
 * was read and sent, not swapped for an example. The stub answers a failure, so no plan from anywhere shows.
 */
async function stubRealRun(page: import("@playwright/test").Page) {
  const sent: { path: string; code: string | null; bytes: number }[] = [];
  const record = (r: import("@playwright/test").Route) =>
    sent.push({ path: new URL(r.request().url()).pathname, code: r.request().headers()["x-sightwork-test-code"] ?? null, bytes: r.request().postDataBuffer()?.length ?? 0 });
  await page.route("**/api/transcribe", (r) => {
    record(r);
    return r.fulfill({ json: { transcript: "", transcriptTurns: [] } });
  });
  await page.route("**/api/plan", (r) => {
    record(r);
    return r.fulfill({ contentType: "application/x-ndjson", body: JSON.stringify({ state: "failed", step: "planning", message: "Stub stop for the test." }) + "\n" });
  });
  // Real runs need a city and state (e2e/city-region.spec.ts); saved here so these checks reach the code prompt.
  await page.addInitScript(() => window.localStorage.setItem("sightwork:location", JSON.stringify({ city: "Sebring", state: "FL" })));
  return sent;
}

async function saveCodeAndRun(page: import("@playwright/test").Page, sent: { path: string; code: string | null; bytes: number }[]) {
  const card = page.getByRole("group", { name: "Your walkthrough" });
  await page.getByRole("button", { name: "Make my work plan" }).click();
  await expect(card.getByText("Enter the tester code to make a plan from this video.")).toBeVisible();
  await card.getByLabel("Tester code for real runs").fill("stub-code");
  await card.getByRole("button", { name: "Save and make my plan" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "We couldn't finish your plan" })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("Stub stop for the test.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Problems, worst first" })).toHaveCount(0);
  const plan = sent.find((s) => s.path === "/api/plan");
  expect(plan, "a real-run request was sent").toBeTruthy();
  expect(plan!.code).toBe("stub-code");
  expect(plan!.bytes, "frames from the user's own video").toBeGreaterThan(10_000);
}

test("own chosen video, no code saved: prompt, then a real run on that video (never the example plan)", async ({ page }) => {
  const sent = await stubRealRun(page);
  await page.goto("/start?runner=api");
  await page.getByTestId("choose-video-input").setInputFiles(WALKTHROUGH);
  await saveCodeAndRun(page, sent);
});

test("own recorded video, no code saved: prompt, then a real run on that take (never the example plan)", async ({ page }) => {
  const sent = await stubRealRun(page);
  await page.goto("/start?runner=api");
  await page.getByRole("button", { name: "Record a walkthrough" }).click();
  const cam = page.getByRole("group", { name: "Camera" });
  await expect(cam).toHaveAttribute("data-phase", "ready");
  await cam.getByRole("button", { name: "Start recording" }).click();
  await page.waitForTimeout(6300);
  await cam.getByRole("button", { name: "Stop recording" }).click();
  await expect(page.getByRole("group", { name: "Your walkthrough" })).toContainText(/walkthrough-\d{4}-\d{2}-\d{2}-\d{4}\.(webm|mp4)/);
  await saveCodeAndRun(page, sent);
});

test("quiet narration is brought up to a level speech recognition can hear before it is sent", async ({ page }) => {
  let peak = -1;
  await page.route("**/api/transcribe", (r) => {
    const body = JSON.parse(r.request().postData() ?? "{}") as { audioWavBase64?: string };
    const wav = Buffer.from(body.audioWavBase64 ?? "", "base64");
    peak = 0;
    for (let o = 44; o + 1 < wav.length; o += 2) peak = Math.max(peak, Math.abs(wav.readInt16LE(o)) / 32768);
    return r.fulfill({ json: { transcript: "", transcriptTurns: [] } });
  });
  await page.route("**/api/plan", (r) =>
    r.fulfill({ contentType: "application/x-ndjson", body: JSON.stringify({ state: "failed", step: "planning", message: "Stub stop for the test." }) + "\n" }),
  );
  await page.addInitScript(() => window.localStorage.setItem("sightwork:test-code", "stub-code"));
  await page.addInitScript(() => window.localStorage.setItem("sightwork:location", JSON.stringify({ city: "Sebring", state: "FL" })));
  await page.goto("/start?runner=api");
  await page.getByTestId("choose-video-input").setInputFiles(QUIET_NARRATION_CLIP);
  await page.getByRole("button", { name: "Make my work plan" }).click();
  await expect(page.getByText("Stub stop for the test.")).toBeVisible({ timeout: 30_000 });
  // The source tone peaks near 0.05; the sent WAV is lifted to about 0.7 without clipping.
  expect(peak, "narration was sent").toBeGreaterThan(0.5);
  expect(peak).toBeLessThan(0.95);
});

test("a chosen phone .mov with a Spatial Audio track listed first still sends its narration", async ({ page }) => {
  // Like iPhone 16+ camera files: QuickTime, an 'apac' sound track before the stereo AAC one. Decoding
  // the whole file fails here (as it does for any iPhone .mov in iOS Safari), so before the fix the
  // run went out with no narration and /api/transcribe was never called.
  let peak = -1;
  let seconds = 0;
  await page.route("**/api/transcribe", (r) => {
    const body = JSON.parse(r.request().postData() ?? "{}") as { audioWavBase64?: string };
    const wav = Buffer.from(body.audioWavBase64 ?? "", "base64");
    seconds = (wav.length - 44) / 2 / wav.readUInt32LE(24);
    peak = 0;
    for (let o = 44; o + 1 < wav.length; o += 2) peak = Math.max(peak, Math.abs(wav.readInt16LE(o)) / 32768);
    return r.fulfill({ json: { transcript: "", transcriptTurns: [] } });
  });
  await page.route("**/api/plan", (r) =>
    r.fulfill({ contentType: "application/x-ndjson", body: JSON.stringify({ state: "failed", step: "planning", message: "Stub stop for the test." }) + "\n" }),
  );
  await page.addInitScript(() => window.localStorage.setItem("sightwork:test-code", "stub-code"));
  await page.addInitScript(() => window.localStorage.setItem("sightwork:location", JSON.stringify({ city: "Sebring", state: "FL" })));
  await page.goto("/start?runner=api");
  await page.getByTestId("choose-video-input").setInputFiles(PHONE_MOV_SPATIAL_FIRST);
  await page.getByRole("button", { name: "Make my work plan" }).click();
  await expect(page.getByText("Stub stop for the test.")).toBeVisible({ timeout: 30_000 });
  expect(peak, "narration was sent to /api/transcribe").toBeGreaterThan(0.3);
  expect(seconds).toBeGreaterThan(5.8);
  expect(seconds).toBeLessThan(6.3);
});

test.describe("server refuses the code", () => {
  test.use({ expectedConsoleErrors: [/status of 401/] });
test("a code the server refuses goes back to the same video with the code prompt", async ({ page }) => {
  await page.route("**/api/transcribe", (r) => r.fulfill({ status: 401, json: { error: "x" } }));
  await page.route("**/api/plan", (r) => r.fulfill({ status: 401, json: { error: "x" } }));
  await page.addInitScript(() => window.localStorage.setItem("sightwork:test-code", "wrong-code"));
  await page.addInitScript(() => window.localStorage.setItem("sightwork:location", JSON.stringify({ city: "Sebring", state: "FL" })));
  await page.goto("/start?runner=api");
  await page.getByTestId("choose-video-input").setInputFiles(WALKTHROUGH);
  await page.getByRole("button", { name: "Make my work plan" }).click();
  await expect(page.getByText("That tester code wasn't accepted. Check it and enter it again, or open the example plan.")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/Something went wrong|couldn't read that video/)).toHaveCount(0);
  await page.getByRole("button", { name: "Enter tester code" }).click();
  const card = page.getByRole("group", { name: "Your walkthrough" });
  await expect(card).toContainText("walkthrough-6s.webm");
  await expect(card.getByText("Enter the tester code to make a plan from this video.")).toBeVisible();
});
});

test("real run of an all-black take stops on the device with a clear message and sends nothing", async ({ page }) => {
  await page.addInitScript(() => window.localStorage.setItem("sightwork:test-code", "stub-code"));
  await page.addInitScript(() => window.localStorage.setItem("sightwork:location", JSON.stringify({ city: "Sebring", state: "FL" })));
  await page.goto("/start?runner=api");
  await page.getByTestId("choose-video-input").setInputFiles(BLANK_CLIP);
  await page.getByRole("button", { name: "Make my work plan" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "We couldn't finish your plan" })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/Every frame of this video came out blank or black/)).toBeVisible();
  await expect(page.getByText(/We couldn't read that video/)).toHaveCount(0);
  await expectNoSideScroll(page);
  await expectNoAxeViolations(page, "blank take message");
  // The apiCalls fixture then checks that no /api request left the browser.
});

test("the server gate answers 401 to an API call with no tester code", async ({ request }) => {
  // Body is deliberately empty: even past the gate it would be rejected before any model call.
  const res = await request.post("/api/plan", { data: {} });
  expect(res.status()).toBe(401);
  expect(res.headers()["cache-control"]).toContain("no-store");
});

test("a step failure (?fail=planning) shows the error card, and Try again runs it again", async ({ page }) => {
  await page.goto("/start?fail=planning");
  await page.getByTestId("choose-video-input").setInputFiles(WALKTHROUGH);
  await page.getByRole("button", { name: "Make my work plan" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "We couldn't finish your plan" })).toBeVisible({ timeout: 30_000 });
  const retry = page.getByRole("button", { name: "Try again" });
  await expect(retry).toBeFocused();
  await expectNoAxeViolations(page, "failure card");
  await retry.click();
  await expect(page.getByRole("heading", { level: 1, name: "Working on your plan" })).toBeVisible();
});

test("?mock=nometa: SAM and the after picture show as skipped, the plan still comes back", async ({ page }) => {
  await page.goto("/start?mock=nometa");
  await page.getByTestId("choose-video-input").setInputFiles(WALKTHROUGH);
  await page.getByRole("button", { name: "Make my work plan" }).click();
  // Looking and Counting flip to skipped once Comparing starts (the step state is announced as text).
  await expect(page.getByText(/skipped this run/i).first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("heading", { name: "Problems, worst first" })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("Off this run").first()).toBeVisible();
  // The stand-in plan is hand-written, so its frames don't promise outlines.
  await expect(page.getByText(/coming soon/i)).toHaveCount(0);
});

test("processing: running clock and tab title follow the run, the screen is kept on, a stop freezes the total", async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as { __wake: { requested: number; released: number } };
    w.__wake = { requested: 0, released: 0 };
    Object.defineProperty(navigator, "wakeLock", {
      configurable: true,
      value: {
        request: async () => {
          w.__wake.requested++;
          const s = {
            released: false,
            release: async () => {
              if (!s.released) w.__wake.released++;
              s.released = true;
            },
          };
          return s;
        },
      },
    });
  });
  const wake = () => page.evaluate(() => (window as unknown as { __wake: { requested: number; released: number } }).__wake);
  await page.goto("/start?fail=planning");
  await page.getByTestId("choose-video-input").setInputFiles(WALKTHROUGH);
  await page.getByRole("button", { name: "Make my work plan" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Working on your plan" })).toBeVisible();
  await expect(page.getByText(/^\d+:\d\d\s*\d+ seconds? elapsed$/)).toBeVisible();
  await expect(page.getByText(/we'll keep your screen on/)).toBeVisible();
  await expect(page).toHaveTitle(/^Step \d of \d · SightWork$/);
  await expect.poll(async () => (await wake()).requested).toBeGreaterThan(0);
  await expectNoSideScroll(page);

  await expect(page.getByRole("heading", { level: 1, name: "We couldn't finish your plan" })).toBeVisible({ timeout: 30_000 });
  await expect(page).toHaveTitle("Stopped · SightWork");
  await expect(page.getByText(/in total$/)).toBeVisible();
  await expect.poll(async () => (await wake()).released).toBeGreaterThan(0);
  // Mock steps finish in under a second, so no step shows a time (no "0 s" noise); real steps show "· 12 s".
  await expect(page.getByText(/· 0 s/)).toHaveCount(0);
  await expectNoAxeViolations(page, "failure card with times");
});

test("a real run with a city names the pricing step: Muse Spark with web search on the Planning row", async ({ page }) => {
  await stubRealRun(page);
  await page.addInitScript(() => window.localStorage.setItem("sightwork:test-code", "stub-code"));
  await page.goto("/start?runner=api");
  await page.getByTestId("choose-video-input").setInputFiles(WALKTHROUGH);
  await page.getByRole("button", { name: "Make my work plan" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "We couldn't finish your plan" })).toBeVisible({ timeout: 30_000 });
  const planning = page.getByRole("listitem").filter({ hasText: "Planning the work" });
  await expect(planning).toContainText("via Muse Spark with web search");
  await expectNoSideScroll(page);
});

test("a real run's time line uses measured times, then says so when it runs long", async ({ page }) => {
  await page.clock.install();
  await page.addInitScript(() => {
    window.localStorage.setItem("sightwork:test-code", "stub-code");
    window.localStorage.setItem("sightwork:location", JSON.stringify({ city: "Sebring", state: "FL" }));
  });
  await page.route("**/api/transcribe", (r) => r.fulfill({ json: { transcript: "", transcriptTurns: [] } }));
  // Hold the plan request open so the run stays on the processing screen.
  await page.route("**/api/plan", () => new Promise<void>(() => {}));
  await page.goto("/start?runner=api");
  await page.getByTestId("choose-video-input").setInputFiles(WALKTHROUGH);
  await page.getByRole("button", { name: "Make my work plan" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Working on your plan" })).toBeVisible();
  const hint = page.getByTestId("run-time-hint");
  await expect(hint).toContainText("Usually about 3 minutes, including live prices for Sebring, FL.");
  await expectNoSideScroll(page);
  await page.clock.fastForward("03:40");
  await expect(hint).toContainText("Taking a little longer than usual. It's still working.");
  await page.clock.fastForward("01:00");
  await expect(hint).toContainText("close to the 5-minute limit");
  await expectNoAxeViolations(page, "long-running real run");
});
