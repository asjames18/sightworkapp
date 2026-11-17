import { test } from "node:test";
import assert from "node:assert/strict";
import { summarize } from "@/lib/usage/summary";
import type { UsageRow } from "@/lib/usage/store";

const rows: UsageRow[] = [
  { day: "2026-11-16", site: "production", event: "view", detail: "/", device: "phone", count: 5 },
  { day: "2026-11-16", site: "production", event: "view", detail: "/pricing", device: "desktop", count: 2 },
  { day: "2026-11-15", site: "production", event: "view", detail: "/", device: "desktop", count: 1 },
  { day: "2026-11-16", site: "production", event: "plan_started", detail: "byok", device: "phone", count: 2 },
  { day: "2026-11-16", site: "production", event: "plan_done", detail: "byok", device: "phone", count: 1 },
  { day: "2026-11-16", site: "production", event: "plan_failed", detail: "code", device: "desktop", count: 1 },
  { day: "2026-11-16", site: "production", event: "checkout_started", detail: "pack5", device: "", count: 2 },
  { day: "2026-11-16", site: "production", event: "checkout_done", detail: "", device: "", count: 1 },
  { day: "2026-11-16", site: "production", event: "recover_used", detail: "", device: "", count: 1 },
  { day: "2026-11-16", site: "preview", event: "view", detail: "/", device: "phone", count: 99 },
];

test("summarize totals one site and keeps test builds out", () => {
  const s = summarize(rows, "production");
  assert.equal(s.views, 8);
  assert.deepEqual(s.pages, [{ page: "/", count: 6 }, { page: "/pricing", count: 2 }]);
  assert.deepEqual(s.devices, [{ device: "phone", count: 5 }, { device: "desktop", count: 3 }]);
  assert.deepEqual(s.plans, [
    { mode: "byok", started: 2, done: 1, failed: 0 },
    { mode: "code", started: 0, done: 0, failed: 1 },
  ]);
  assert.equal(s.checkoutsStarted, 2);
  assert.deepEqual(s.checkoutsByPlan, [{ plan: "pack5", count: 2 }]);
  assert.equal(s.checkoutsDone, 1);
  assert.equal(s.recoverUsed, 1);
  assert.deepEqual(s.byDay.map((d) => d.day), ["2026-11-16", "2026-11-15"]);
  assert.equal(s.byDay[0].views, 7);
  assert.equal(summarize(rows, "preview").views, 99);
});

test("summarize handles no rows", () => {
  const s = summarize([], "production");
  assert.equal(s.views, 0);
  assert.deepEqual(s.byDay, []);
});
