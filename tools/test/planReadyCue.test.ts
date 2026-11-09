/** Plan-ready tab cue (planReadyCue.ts). A fake document, no browser. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { cuePlanReady, planReadyTitle } from "@/lib/client/planReadyCue";

function fakeDoc(hidden: boolean, title = "SightWork") {
  const listeners = new Set<() => void>();
  const doc = {
    hidden,
    title,
    addEventListener: (_t: string, fn: () => void) => void listeners.add(fn),
    removeEventListener: (_t: string, fn: () => void) => void listeners.delete(fn),
    show() {
      doc.hidden = false;
      for (const fn of [...listeners]) fn();
    },
    listeners,
  };
  return doc;
}

test("title names the problem count", () => {
  assert.equal(planReadyTitle(7), "Plan ready: 7 problems · SightWork");
  assert.equal(planReadyTitle(1), "Plan ready: 1 problem · SightWork");
  assert.equal(planReadyTitle(0), "Plan ready: 0 problems · SightWork");
});

test("title without a usable count", () => {
  assert.equal(planReadyTitle(undefined), "Plan ready · SightWork");
  assert.equal(planReadyTitle(Number.NaN), "Plan ready · SightWork");
  assert.equal(planReadyTitle(-2), "Plan ready: 0 problems · SightWork");
});

test("visible tab: no cue, no listener", () => {
  const doc = fakeDoc(false);
  cuePlanReady(5, doc as never);
  assert.equal(doc.title, "SightWork");
  assert.equal(doc.listeners.size, 0);
});

test("hidden tab: cue until the tab is shown, then the old title", () => {
  const doc = fakeDoc(true);
  cuePlanReady(5, doc as never);
  assert.equal(doc.title, "Plan ready: 5 problems · SightWork");
  doc.show();
  assert.equal(doc.title, "SightWork");
  assert.equal(doc.listeners.size, 0);
});

test("cleanup restores the title and is safe twice", () => {
  const doc = fakeDoc(true);
  const stop = cuePlanReady(2, doc as never);
  stop();
  stop();
  assert.equal(doc.title, "SightWork");
  assert.equal(doc.listeners.size, 0);
});

test("a title set by something else is left alone", () => {
  const doc = fakeDoc(true);
  cuePlanReady(2, doc as never);
  doc.title = "Other · SightWork";
  doc.show();
  assert.equal(doc.title, "Other · SightWork");
});

test("no document (server render): nothing happens", () => {
  assert.doesNotThrow(() => cuePlanReady(3, undefined)());
});

import { buzzPlanReady, PLAN_READY_BUZZ } from "@/lib/client/planReadyCue";

function fakeNav(result = true) {
  const calls: unknown[] = [];
  return { calls, vibrate: (p: number | number[]) => (calls.push(p), result) };
}
const motionOk = { matchMedia: () => ({ matches: false }) };
const reduced = { matchMedia: (q: string) => ({ matches: q.includes("reduce") }) };

test("buzz: sends two short pulses when vibration is supported", () => {
  const nav = fakeNav();
  assert.equal(buzzPlanReady(nav, motionOk), true);
  assert.deepEqual(nav.calls, [[70, 90, 70]]);
  assert.ok(PLAN_READY_BUZZ.reduce((a, b) => a + b, 0) < 500, "never a long alarm");
});

test("buzz: skipped with reduced motion", () => {
  const nav = fakeNav();
  assert.equal(buzzPlanReady(nav, reduced), false);
  assert.equal(nav.calls.length, 0);
});

test("buzz: no vibration support (iPhone Safari, desktop) does nothing", () => {
  assert.equal(buzzPlanReady({}, motionOk), false);
  assert.equal(buzzPlanReady(undefined, motionOk), false);
});

test("buzz: works without matchMedia and never throws", () => {
  const nav = fakeNav();
  assert.equal(buzzPlanReady(nav, {}), true);
  assert.equal(buzzPlanReady(nav, undefined), true);
  const throwing = { vibrate: () => { throw new Error("blocked"); } };
  assert.equal(buzzPlanReady(throwing, motionOk), false);
  assert.equal(buzzPlanReady(fakeNav(false), motionOk), false);
});
