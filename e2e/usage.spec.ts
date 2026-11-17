import { test, expect } from "@playwright/test";

/**
 * Anonymous usage counts (docs/USAGE-COUNTS.md). The e2e build has no counter store set, so counting is off:
 * the counter answers 204 and keeps nothing, and the report and its page are hidden.
 */
test("the usage counter answers 204 with no body, set up or not", async ({ request }) => {
  const res = await request.post("/api/usage", { data: '{"e":"view","d":"/"}', headers: { "content-type": "text/plain" } });
  expect(res.status()).toBe(204);
  expect(await res.text()).toBe("");
  expect(res.headers()["cache-control"]).toContain("no-store");
  expect(res.headers()["set-cookie"]).toBeUndefined();
});

test("junk and cross-site beacons get the same 204", async ({ request }) => {
  for (const data of ["nope", '{"e":"hack"}', "x".repeat(5000)]) {
    const res = await request.post("/api/usage", { data, headers: { "content-type": "text/plain", origin: "https://evil.example" } });
    expect(res.status()).toBe(204);
  }
});

test("the usage report and page are hidden until counting and a view key are set up", async ({ request }) => {
  const report = await request.post("/api/usage/report", { data: { key: "x".repeat(64) } });
  expect(report.status()).toBe(404);
  expect((await request.get("/admin/usage")).status()).toBe(404);
});

test("with counting off, the landing page sends nothing and has no counting note", async ({ page }) => {
  const calls: string[] = [];
  page.on("request", (r) => {
    if (new URL(r.url()).pathname.startsWith("/api/")) calls.push(r.url());
  });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "The honest fine print" })).toBeVisible();
  await expect(page.getByText(/anonymous daily totals/)).toHaveCount(0);
  await page.goto("/pricing");
  expect(calls).toEqual([]);
});
