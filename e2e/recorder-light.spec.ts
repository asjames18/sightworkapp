import { test, expect, expectNoAxeViolations, expectNoSideScroll } from "./helpers";

/**
 * Recorder phone light: a camera that reports a flashlight gets a Light on / Light off button that asks
 * the track for it; a camera without one shows no button. The fake camera has no light, so the first
 * test makes the video track report one and records what the page asks for.
 */
test.beforeEach(async ({ apiCalls, pageErrors, context }) => {
  void apiCalls;
  void pageErrors;
  await context.grantPermissions(["camera", "microphone"]);
});

const fakeTorch = () => {
  const w = window as unknown as { __torch: unknown[] };
  w.__torch = [];
  const proto = MediaStreamTrack.prototype;
  const caps = proto.getCapabilities;
  proto.getCapabilities = function (this: MediaStreamTrack) {
    const c = caps.call(this);
    return this.kind === "video" ? { ...c, torch: true } : c;
  } as typeof proto.getCapabilities;
  const apply = proto.applyConstraints;
  proto.applyConstraints = function (this: MediaStreamTrack, c?: MediaTrackConstraints) {
    const adv = c?.advanced?.[0] as { torch?: boolean } | undefined;
    if (this.kind === "video" && adv && "torch" in adv) {
      w.__torch.push(adv.torch);
      return Promise.resolve();
    }
    return apply.call(this, c);
  };
};

for (const width of [375, 768, 1280]) {
  test(`recorder: phone light button (${width} px)`, async ({ page }) => {
    await page.addInitScript(fakeTorch);
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/start");
    await page.getByRole("button", { name: "Record a walkthrough" }).click();
    const cam = page.getByRole("group", { name: "Camera" });
    await expect(cam).toHaveAttribute("data-phase", "ready");
    const light = cam.getByTestId("torch-toggle");
    await expect(light).toHaveText("Light on");
    await expect(light).toHaveAttribute("aria-pressed", "false");
    await light.click();
    await expect(light).toHaveText("Light off");
    await expect(light).toHaveAttribute("aria-pressed", "true");
    await expectNoSideScroll(page);
    await expectNoAxeViolations(page, `recorder light on (${width} px)`);

    await cam.getByRole("button", { name: "Start recording" }).click();
    await expect(cam).toHaveAttribute("data-phase", "recording");
    await expect(light).toBeVisible();
    await light.click();
    await expect(light).toHaveText("Light on");
    expect(await page.evaluate(() => (window as unknown as { __torch: unknown[] }).__torch)).toEqual([true, false]);
    await expectNoSideScroll(page);
    await expectNoAxeViolations(page, `recorder recording with light (${width} px)`);
    await cam.getByRole("button", { name: "Cancel" }).click();
  });
}

test("recorder: no light button when the camera has no flashlight", async ({ page }) => {
  await page.goto("/start");
  await page.getByRole("button", { name: "Record a walkthrough" }).click();
  const cam = page.getByRole("group", { name: "Camera" });
  await expect(cam).toHaveAttribute("data-phase", "ready");
  await expect(cam.getByTestId("torch-toggle")).toHaveCount(0);
  await cam.getByRole("button", { name: "Cancel" }).click();
});

test("recorder: on a 320x568 phone the light sits beside Cancel and Start still fits on screen", async ({ page }) => {
  await page.addInitScript(fakeTorch);
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto("/start");
  await page.getByRole("button", { name: "Record a walkthrough" }).click();
  const cam = page.getByRole("group", { name: "Camera" });
  await expect(cam).toHaveAttribute("data-phase", "ready");
  const light = cam.getByTestId("torch-toggle");
  const cancel = cam.getByRole("button", { name: "Cancel" });
  await expect(cam.getByRole("button", { name: "Start recording" })).toBeInViewport();
  await expect(light).toBeVisible();
  await expect
    .poll(async () => {
      const [a, b] = await Promise.all([light.boundingBox(), cancel.boundingBox()]);
      return a && b ? Math.abs(a.y - b.y) : null;
    })
    .toBeLessThan(2);
  const a = await light.boundingBox();
  expect(a!.height).toBeGreaterThanOrEqual(44);
  await expectNoSideScroll(page);
  await cancel.click();
});
