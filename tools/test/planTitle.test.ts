/** Plan tab title (planTitle.ts). A fake document, no browser. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { planPageTitle, showPlanTitle } from "@/lib/client/planTitle";
import { cuePlanReady } from "@/lib/client/planReadyCue";

test("names the space", () => {
  assert.equal(planPageTitle("Sanctuary stage"), "Sanctuary stage plan | SightWork");
  assert.equal(planPageTitle("  Fellowship   hall \n"), "Fellowship hall plan | SightWork");
});

test("no double plan", () => {
  assert.equal(planPageTitle("Kitchen repair plan"), "Kitchen repair plan | SightWork");
  assert.equal(planPageTitle("Stage Plan"), "Stage Plan | SightWork");
});

test("no usable name", () => {
  assert.equal(planPageTitle(""), "Your plan | SightWork");
  assert.equal(planPageTitle("   "), "Your plan | SightWork");
  assert.equal(planPageTitle(null), "Your plan | SightWork");
  assert.equal(planPageTitle(undefined), "Your plan | SightWork");
});

test("long names are cut at a word break", () => {
  const t = planPageTitle("Main sanctuary stage, choir loft, baptistry and the side storage rooms behind it");
  assert.ok(t.endsWith("… plan | SightWork"), t);
  const name = t.replace(/… plan \| SightWork$/, "");
  assert.ok(name.length <= 48, name);
  assert.ok(!/[\s,]$/.test(name), name);
  assert.ok("Main sanctuary stage, choir loft, baptistry and the side".startsWith(name), name);
});

test("one very long word is cut hard", () => {
  const t = planPageTitle("x".repeat(80));
  assert.equal(t, `${"x".repeat(48)}… plan | SightWork`);
});

test("show and restore", () => {
  const doc = { title: "Make a work plan | SightWork" };
  const stop = showPlanTitle("Sanctuary stage", doc);
  assert.equal(doc.title, "Sanctuary stage plan | SightWork");
  stop();
  assert.equal(doc.title, "Make a work plan | SightWork");
});

test("restore leaves a title someone else set", () => {
  const doc = { title: "SightWork" };
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
    title: "SightWork",
    addEventListener: (_t: string, fn: () => void) => void listeners.add(fn),
    removeEventListener: (_t: string, fn: () => void) => void listeners.delete(fn),
  };
  const stopTitle = showPlanTitle("Sanctuary stage", doc);
  cuePlanReady(3, doc as never);
  assert.equal(doc.title, "Plan ready: 3 problems · SightWork");
  doc.hidden = false;
  for (const fn of [...listeners]) fn();
  assert.equal(doc.title, "Sanctuary stage plan | SightWork");
  stopTitle();
  assert.equal(doc.title, "SightWork");
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
  const doc = { title: "Make a work plan | SightWork", head: {} as Node };
  const stop = showPlanTitle("Sanctuary stage", doc, FakeObserver as never);
  doc.title = "Make a work plan | SightWork";
  fire!();
  assert.equal(doc.title, "Sanctuary stage plan | SightWork");
  // Any other title (the plan-ready cue, another screen) is left alone.
  doc.title = "Plan ready: 2 problems · SightWork";
  fire!();
  assert.equal(doc.title, "Plan ready: 2 problems · SightWork");
  doc.title = "Sanctuary stage plan | SightWork";
  stop();
  assert.ok(disconnected);
  assert.equal(doc.title, "Make a work plan | SightWork");
});
