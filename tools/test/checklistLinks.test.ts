/** Problem links on the "What SightWork checked" rows (checklistLinks.ts). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { areaProblemRanks, areaProblemsLabel } from "@/lib/client/checklistLinks";
import { checklistRows } from "@/lib/checklist";

const issues = [
  { rank: 4, checklistKey: "ceiling" },
  { rank: 1, checklistKey: "plumbing" },
  { rank: 3, checklistKey: "water_stain" },
  { rank: 2, checklistKey: "walls" },
  { rank: 5, checklistKey: "nothing_we_know" },
  { rank: 6, hazard: "exposed_wiring" },
] as never[];

test("lists an area's problem ranks lowest first", () => {
  assert.deepEqual(areaProblemRanks(issues, "walls"), [2, 3, 4]);
  assert.deepEqual(areaProblemRanks(issues, "plumbing"), [1]);
  assert.deepEqual(areaProblemRanks(issues, "electrical"), [6]);
  assert.deepEqual(areaProblemRanks(issues, "other"), [5]);
});

test("an area with nothing found has no links", () => {
  assert.deepEqual(areaProblemRanks(issues, "lighting"), []);
  assert.deepEqual(areaProblemRanks([], "walls"), []);
});

test("the ranks match the row's problem count", () => {
  for (const row of checklistRows(issues)) assert.equal(areaProblemRanks(issues, row.id).length, row.found, row.id);
});

test("drops repeats and ranks with no card", () => {
  const odd = [
    { rank: 2, checklistKey: "walls" },
    { rank: 2, checklistKey: "walls" },
    { rank: 0, checklistKey: "walls" },
    { rank: -1, checklistKey: "walls" },
    { rank: 1.5, checklistKey: "walls" },
    { rank: Number.NaN, checklistKey: "walls" },
  ] as never[];
  assert.deepEqual(areaProblemRanks(odd, "walls"), [2]);
});

test("spoken label names the area and the numbers", () => {
  assert.equal(areaProblemsLabel("Electrical", [6]), "Problem in Electrical: 6");
  assert.equal(areaProblemsLabel("Walls", [2, 3]), "Problems in Walls: 2 and 3");
  assert.equal(areaProblemsLabel("Walls", [2, 3, 4]), "Problems in Walls: 2, 3 and 4");
  assert.equal(areaProblemsLabel("Walls", []), "");
});
