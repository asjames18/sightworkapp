// Turns the daily rows into the totals the usage page shows. Pure, so it's tested directly.
import type { UsageRow } from "./store";

export type UsageSummary = {
  views: number;
  pages: { page: string; count: number }[];
  devices: { device: string; count: number }[];
  plans: { mode: string; started: number; done: number; failed: number }[];
  checkoutsStarted: number;
  checkoutsByPlan: { plan: string; count: number }[];
  checkoutsDone: number;
  recoverUsed: number;
  byDay: { day: string; views: number; plansStarted: number; plansDone: number; checkoutsDone: number }[];
};

function sorted(m: Map<string, number>, key: string) {
  return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([k, count]) => ({ [key]: k, count }));
}

export function summarize(rows: UsageRow[], site: "production" | "preview"): UsageSummary {
  const pages = new Map<string, number>();
  const devices = new Map<string, number>();
  const plans = new Map<string, { started: number; done: number; failed: number }>();
  const checkoutPlans = new Map<string, number>();
  const days = new Map<string, { views: number; plansStarted: number; plansDone: number; checkoutsDone: number }>();
  let views = 0;
  let checkoutsStarted = 0;
  let checkoutsDone = 0;
  let recoverUsed = 0;
  for (const r of rows) {
    if (r.site !== site) continue;
    const d = days.get(r.day) ?? { views: 0, plansStarted: 0, plansDone: 0, checkoutsDone: 0 };
    days.set(r.day, d);
    if (r.event === "view") {
      views += r.count;
      d.views += r.count;
      pages.set(r.detail, (pages.get(r.detail) ?? 0) + r.count);
      devices.set(r.device || "unknown", (devices.get(r.device || "unknown") ?? 0) + r.count);
    } else if (r.event.startsWith("plan_")) {
      const p = plans.get(r.detail) ?? { started: 0, done: 0, failed: 0 };
      plans.set(r.detail, p);
      if (r.event === "plan_started") {
        p.started += r.count;
        d.plansStarted += r.count;
      } else if (r.event === "plan_done") {
        p.done += r.count;
        d.plansDone += r.count;
      } else if (r.event === "plan_failed") p.failed += r.count;
    } else if (r.event === "checkout_started") {
      checkoutsStarted += r.count;
      checkoutPlans.set(r.detail || "unknown", (checkoutPlans.get(r.detail || "unknown") ?? 0) + r.count);
    } else if (r.event === "checkout_done") {
      checkoutsDone += r.count;
      d.checkoutsDone += r.count;
    } else if (r.event === "recover_used") recoverUsed += r.count;
  }
  return {
    views,
    pages: sorted(pages, "page") as { page: string; count: number }[],
    devices: sorted(devices, "device") as { device: string; count: number }[],
    plans: [...plans.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([mode, p]) => ({ mode, ...p })),
    checkoutsStarted,
    checkoutsByPlan: sorted(checkoutPlans, "plan") as { plan: string; count: number }[],
    checkoutsDone,
    recoverUsed,
    byDay: [...days.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([day, v]) => ({ day, ...v })),
  };
}
