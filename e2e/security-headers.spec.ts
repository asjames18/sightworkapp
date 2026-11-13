import { test, expect } from "@playwright/test";

/**
 * Every page and the API gate answer with the baseline security headers: no framing by other sites, no MIME
 * sniffing, a trimmed referrer, and camera and microphone limited to this site. Nothing here reaches a model:
 * the API request carries no tester code, so the gate answers 401 before any route code runs.
 */
const EXPECTED: Record<string, RegExp> = {
  "content-security-policy": /frame-ancestors 'none'.*object-src 'none'.*base-uri 'self'/,
  "x-frame-options": /^DENY$/,
  "x-content-type-options": /^nosniff$/,
  "referrer-policy": /^strict-origin-when-cross-origin$/,
  "permissions-policy": /camera=\(self\).*microphone=\(self\).*geolocation=\(\)/,
};

for (const path of ["/", "/start", "/start?view=example&ex=sanctuary", "/status", "/credits"]) {
  test(`security headers on ${path}`, async ({ request }) => {
    const res = await request.get(path);
    expect(res.status()).toBe(200);
    const h = res.headers();
    for (const [name, pattern] of Object.entries(EXPECTED)) expect(h[name], name).toMatch(pattern);
    expect(h["x-powered-by"]).toBeUndefined();
  });
}

test("the API gate answers 401 without a tester code and keeps the headers", async ({ request }) => {
  const res = await request.post("/api/other", { data: {} });
  expect(res.status()).toBe(401);
  expect(res.headers()["x-content-type-options"]).toBe("nosniff");
  expect(res.headers()["cache-control"]).toContain("no-store");
});

test("a plan run without a paid access code (billing on) answers 402 and keeps the headers", async ({ request }) => {
  const res = await request.post("/api/plan", { data: {} });
  expect(res.status()).toBe(402);
  expect(res.headers()["x-content-type-options"]).toBe("nosniff");
  expect(res.headers()["cache-control"]).toContain("no-store");
});
