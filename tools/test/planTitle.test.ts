/** Plan tab title (planTitle.ts). A fake document, no browser. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { planPageTitle, showPlanTitle } from "@/lib/client/planTitle";
import { cuePlanReady } from "@/lib/client/planReadyCue";

test("names the space", () => {
  assert.equal(planPageTitle("Sanctuary stage"), "Sanctuary stage plan | SiteWork");
  assert.equal(planPageTitle("  Fellowship   hall \n"), "Fellowship hall plan | SiteWork");
});

test("no double plan", () => {
  assert.equal(planPageTitle("Kitchen repair plan"), "Kitchen repair plan | SiteWork");
  assert.equal(planPageTitle("Stage Plan"), "Stage Plan | SiteWork");
});

test("no usable name", () => {
  assert.equal(planPageTitle(""), "Your plan | SiteWork");
  assert.equal(planPageTitle("   "), "Your plan | SiteWork");
  assert.equal(planPageTitle(null), "Your plan | SiteWork");
  assert.equal(planPageTitle(undefined), "Your plan | SiteWork");
});

test("long names are cut at a word break", () => {
  const t = planPageTitle("Main sanctuary stage, choir loft, baptistry and the side storage rooms behind it");
  assert.ok(t.endsWith("… plan | SiteWork"), t);
  const name = t.replace(/… plan \| SiteWork$/, "");
  assert.ok(name.length <= 48, name);
  assert.ok(!/[\s,]$/.test(name), name);
  assert.ok("Main sanctuary stage, choir loft, baptistry and the side".startsWith(name), name);
});

test("one very long word is cut hard", () => {
  const t = planPageTitle("x".repeat(80));
  assert.equal(t, `${"x".repeat(48)}… plan | SiteWork`);
});

test("show and restore", () => {
  const doc = { title: "Make a work plan | SiteWork" };
  const stop = showPlanTitle("Sanctuary stage", doc);
  assert.equal(doc.title, "Sanctuary stage plan | SiteWork");
  stop();
  assert.equal(doc.title, "Make a work plan | SiteWork");
});

test("restore leaves a title someone else set", () => {
  const doc = { title: "SiteWork" };
  const stop = showPlanTitle("Sanctuary stage", doc);
  doc.title = "Something else";
  stop();
  assert.equal(doc.title, "Something else");
});

test("no document is a no-op", () => {
  const stop = showPlanTitle("Sanctuary stage", undefined);
  stop();
});

test("plan-ready cue on top comes back to the plan title", () => {
  const listeners = new Set<() => void>();
  const doc = {
    hidden: true,
    title: "SiteWork",
    addEventListener: (_t: string, fn: () => void) => void listeners.add(fn),
    removeEventListener: (_t: string, fn: () => void) => void listeners.delete(fn),
  };
  const stopTitle = showPlanTitle("Sanctuary stage", doc);
  cuePlanReady(3, doc as never);
  assert.equal(doc.title, "Plan ready: 3 problems · SiteWork");
  doc.hidden = false;
  for (const fn of [...listeners]) fn();
  assert.equal(doc.title, "Sanctuary stage plan | SiteWork");
  stopTitle();
  assert.equal(doc.title, "SiteWork");
});

test("a page-title reset while the plan is open is turned back", () => {
  let fire: (() => void) | null = null;
  let disconnected = false;
  class FakeObserver {
    constructor(cb: () => void) {
      fire = cb;
    }
    observe() {}
    disconnect() {
      disconnected = true;
    }
  }
  const doc = { title: "Make a work plan | SiteWork", head: {} as Node };
  const stop = showPlanTitle("Sanctuary stage", doc, FakeObserver as never);
  doc.title = "Make a work plan | SiteWork";
  fire!();
  assert.equal(doc.title, "Sanctuary stage plan | SiteWork");
  // Any other title (the plan-ready cue, another screen) is left alone.
  doc.title = "Plan ready: 2 problems · SiteWork";
  fire!();
  assert.equal(doc.title, "Plan ready: 2 problems · SiteWork");
  doc.title = "Sanctuary stage plan | SiteWork";
  stop();
  assert.ok(disconnected);
  assert.equal(doc.title, "Make a work plan | SiteWork");
});
