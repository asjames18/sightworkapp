/** Materials shopping list: ticks kept per plan on this device, and the still-needed list as text. No network. */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { gotLine, loadGotMaterials, planMaterialsKey, saveGotMaterials, shoppingListText } from "@/lib/client/materialsList";
import { fakeWindow, noWindow } from "./browser-stubs";

const plan = {
  spaceName: "Main stage",
  materials: [
    { item: "Cable cover, 6 ft", qty: "2", unitCost: [25, 40] as [number, number], forIssues: [1] },
    { item: "Gaffer tape", qty: "1 roll", forIssues: [1, 3] },
    { item: "Handrail kit", qty: "1", note: "match the step width", unitCost: [80, 80] as [number, number] },
  ],
};

function windowWithKeys() {
  const { store } = fakeWindow();
  const ls = (globalThis as unknown as { window: { localStorage: Record<string, unknown> } }).window.localStorage;
  Object.defineProperty(ls, "length", { get: () => store.size });
  ls.key = (i: number) => [...store.keys()][i] ?? null;
  return store;
}

afterEach(() => noWindow());

test("the key is stable for the same plan and changes with the materials", () => {
  assert.equal(planMaterialsKey(plan), planMaterialsKey({ ...plan }));
  assert.match(planMaterialsKey(plan), /^sightwork:materials:v1:[0-9a-z]+$/);
  assert.notEqual(planMaterialsKey(plan), planMaterialsKey({ ...plan, materials: plan.materials.slice(0, 2) }));
  assert.notEqual(planMaterialsKey(plan), planMaterialsKey({ ...plan, spaceName: "Classroom" }));
});

test("ticks load back sorted, deduplicated and limited to items that exist", () => {
  const store = windowWithKeys();
  assert.deepEqual(loadGotMaterials(plan), []);
  assert.equal(saveGotMaterials(plan, [2, 0, 2]), true);
  assert.deepEqual(loadGotMaterials(plan), [0, 2]);
  store.set(planMaterialsKey(plan), JSON.stringify({ got: [1, 7, -1, 1.5, "x"], at: 1 }));
  assert.deepEqual(loadGotMaterials(plan), [1]);
  saveGotMaterials(plan, []);
  assert.equal(store.size, 0);
});

test("only the newest 20 plans are kept, and step ticks are left alone", () => {
  const store = windowWithKeys();
  store.set("sightwork:steps:v1:keep", JSON.stringify({ done: [1], at: 0 }));
  for (let i = 0; i < 25; i++) store.set(`sightwork:materials:v1:old${i}`, JSON.stringify({ got: [0], at: i }));
  saveGotMaterials(plan, [1]);
  const kept = [...store.keys()].filter((k) => k.startsWith("sightwork:materials:v1:"));
  assert.equal(kept.length, 20);
  assert.ok(store.has(planMaterialsKey(plan)));
  assert.ok(store.has("sightwork:steps:v1:keep"));
});

test("storage that throws fails quietly", () => {
  noWindow();
  assert.deepEqual(loadGotMaterials(plan), []);
  assert.equal(saveGotMaterials(plan, [1]), false);
});

test("progress line", () => {
  assert.equal(gotLine(0, 3), "");
  assert.equal(gotLine(1, 3), "1 of 3 items in hand.");
  assert.equal(gotLine(3, 3), "All 3 items in hand.");
  assert.equal(gotLine(1, 1), "The item is in hand.");
});

test("the shopping list lists only what's still needed, with quantity, problems and unit price", () => {
  const all = shoppingListText(plan);
  assert.match(all, /^Shopping list: Main stage\n\n/);
  assert.ok(all.includes("[ ] Cable cover, 6 ft: 2 (for #1; about $25-$40 each)"));
  assert.ok(all.includes("[ ] Gaffer tape: 1 roll (for #1, #3)"));
  assert.ok(all.includes("[ ] Handrail kit: 1 (about $80 each; match the step width)"));
  assert.ok(all.endsWith("Prices are rough estimates, not quotes. Made with SightWork."));

  const left = shoppingListText(plan, [0, 2]);
  assert.ok(left.includes("1 still needed, 2 already in hand."));
  assert.ok(left.includes("Gaffer tape"));
  assert.ok(!left.includes("Cable cover") && !left.includes("Handrail"));
  assert.ok(left.endsWith("\nMade with SightWork."), "no price note when nothing left is priced");

  assert.equal(shoppingListText(plan, [0, 1, 2]), "");
  assert.ok(shoppingListText(plan, [], { sample: true }).includes("(Example plan with sample data, not a real run.)"));
});
