import { test } from "node:test";
import assert from "node:assert/strict";
import { handleUsageBeacon, handleUsageReport, parseBeacon, sameSite } from "@/lib/usage/handler";
import { recordUsage, usageSite, usageStore } from "@/lib/usage/store";

const URL_ = "https://abcdefgh.supabase.co";
const KEY = "sb_publishable_abcdefghijklmnopqrstuvwxyz";
const VIEW = "v".repeat(64);
const ENV = { SIGHTWORK_USAGE_URL: URL_, SIGHTWORK_USAGE_KEY: KEY, SIGHTWORK_USAGE_VIEW_TOKEN: VIEW, VERCEL_ENV: "production" };
const SAME = { host: "sightwork.example", origin: "https://sightwork.example", secFetchSite: "same-origin", userAgent: "Mozilla/5.0 (iPhone) Safari" };

type Call = { url: string; body: Record<string, unknown>; headers: Record<string, string> };
function fake(reply: unknown = null, status = 200) {
  const calls: Call[] = [];
  const impl = async (url: string, init: { method: string; headers: Record<string, string>; body: string }) => {
    calls.push({ url, body: JSON.parse(init.body), headers: init.headers });
    return { ok: status < 300, status, json: async () => reply };
  };
  return { calls, impl };
}

test("usageStore needs both a https address and a key", () => {
  assert.deepEqual(usageStore(ENV), { url: URL_, key: KEY });
  assert.equal(usageStore({ SIGHTWORK_USAGE_URL: URL_ }), null);
  assert.equal(usageStore({ SIGHTWORK_USAGE_URL: "http://x.co", SIGHTWORK_USAGE_KEY: KEY }), null);
  assert.equal(usageStore({}), null);
});

test("usageSite keeps test builds apart from the live site", () => {
  assert.equal(usageSite({ VERCEL_ENV: "production" }), "production");
  assert.equal(usageSite({ VERCEL_ENV: "preview" }), "preview");
  assert.equal(usageSite({}), "preview");
});

test("sameSite accepts only this site's own pages", () => {
  assert.equal(sameSite(SAME), true);
  assert.equal(sameSite({ ...SAME, secFetchSite: "cross-site" }), false);
  assert.equal(sameSite({ ...SAME, origin: "https://evil.example" }), false);
  assert.equal(sameSite({ host: "sightwork.example" }), false);
  assert.equal(sameSite({ ...SAME, origin: "not a url" }), false);
});

test("parseBeacon keeps only the browser's fixed events and details", () => {
  assert.deepEqual(parseBeacon('{"e":"view","d":"/pricing?x=1","v":"phone"}'), { event: "view", detail: "/pricing", device: "phone" });
  assert.deepEqual(parseBeacon('{"e":"plan_done","d":"byok","v":"laptop"}'), { event: "plan_done", detail: "byok", device: "" });
  for (const raw of ["", "nope", "null", '{"e":"checkout_done"}', '{"e":"recover_used"}', '{"e":"plan_done","d":"a@b.co"}', '{"e":"hack"}', "x".repeat(400)])
    assert.equal(parseBeacon(raw), null, raw.slice(0, 30));
});

test("a beacon adds 1 with only event, detail, device and site", async () => {
  const f = fake();
  const r = await handleUsageBeacon('{"e":"view","d":"/start","v":"desktop","email":"a@b.co"}', SAME, { env: ENV, fetchImpl: f.impl });
  assert.deepEqual(r, { status: 204, counted: true });
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, `${URL_}/rest/v1/rpc/sightwork_usage_bump`);
  assert.deepEqual(f.calls[0].body, { p_site: "production", p_event: "view", p_detail: "/start", p_device: "desktop" });
  assert.equal(f.calls[0].headers.apikey, KEY);
});

test("beacons are ignored when off, cross-site, from crawlers or malformed", async () => {
  const f = fake();
  const body = '{"e":"view","d":"/"}';
  assert.equal((await handleUsageBeacon(body, SAME, { env: {}, fetchImpl: f.impl })).counted, false);
  assert.equal((await handleUsageBeacon(body, { ...SAME, secFetchSite: "cross-site" }, { env: ENV, fetchImpl: f.impl })).counted, false);
  assert.equal((await handleUsageBeacon(body, { ...SAME, userAgent: "Googlebot/2.1" }, { env: ENV, fetchImpl: f.impl })).counted, false);
  assert.equal((await handleUsageBeacon(body, { ...SAME, userAgent: "" }, { env: ENV, fetchImpl: f.impl })).counted, false);
  assert.equal((await handleUsageBeacon("{bad", SAME, { env: ENV, fetchImpl: f.impl })).counted, false);
  assert.equal(f.calls.length, 0);
});

test("recordUsage never throws when the store fails", async () => {
  const f = fake(null, 500);
  assert.equal(await recordUsage("checkout_done", "", "", { env: ENV, fetchImpl: f.impl }), false);
  const boom = async () => {
    throw new Error("network");
  };
  assert.equal(await recordUsage("recover_used", "", "", { env: ENV, fetchImpl: boom }), false);
});

test("the report is hidden until set up, and needs the view key", async () => {
  const f = fake([]);
  assert.equal((await handleUsageReport({ key: VIEW }, { env: { ...ENV, SIGHTWORK_USAGE_VIEW_TOKEN: "" }, fetchImpl: f.impl })).status, 404);
  assert.equal((await handleUsageReport({ key: VIEW }, { env: { ...ENV, SIGHTWORK_USAGE_VIEW_TOKEN: "short" }, fetchImpl: f.impl })).status, 404);
  assert.equal((await handleUsageReport({}, { env: ENV, fetchImpl: f.impl })).status, 400);
  assert.equal((await handleUsageReport({ key: "w".repeat(64) }, { env: ENV, fetchImpl: f.impl })).status, 401);
  assert.equal(f.calls.length, 0);
});

test("the report returns clean rows for the right key and clamps the days", async () => {
  const f = fake([
    { day: "2026-11-16", site: "production", event: "view", detail: "/", device: "phone", count: 3 },
    { day: "2026-11-16", site: "preview", event: "plan_done", detail: "byok", device: "", count: "2" },
    { junk: true },
  ]);
  const r = await handleUsageReport({ key: VIEW, days: 9999 }, { env: ENV, fetchImpl: f.impl });
  assert.equal(r.status, 200);
  if (r.status !== 200) return;
  assert.equal(r.body.days, 400);
  assert.equal(r.body.rows.length, 2);
  assert.equal(r.body.rows[1].count, 2);
  assert.deepEqual(f.calls[0].body, { p_token: VIEW, p_days: 400 });
  assert.equal(f.calls[0].url, `${URL_}/rest/v1/rpc/sightwork_usage_read`);
});

test("the report answers 503 when the store can't be read", async () => {
  const f = fake(null, 500);
  assert.equal((await handleUsageReport({ key: VIEW }, { env: ENV, fetchImpl: f.impl })).status, 503);
});
