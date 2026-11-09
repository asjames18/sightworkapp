/**
 * SAMPLE PLANS, written by hand. Each one sits on a single free stock photo (CC0, see
 * public/examples/CREDITS.md) to show what a SightWork plan looks like for a different kind of space.
 * Each carries the richer findings (tier, where, what the photo shows, checklist key, one closer-look find),
 * all read off the photo itself. They are NOT model runs: no SAM counts, no Muse Spark plan, no after picture, no cost. Counts are
 * what is visible in the one photo, and hours are illustrative. The UI labels every one "Sample".
 */
import type { WorkPlan } from "../types";

const one = (url: string) => [{ index: 0, tSec: 0, url, reason: "interval" as const }];
const seen = (rank: number, title: string, detail: string, severity: "high" | "medium" | "low", box: [number, number, number, number], caption: string, category: "safety" | "damage" | "function" | "cosmetic", hazard?: WorkPlan["issues"][number]["hazard"]) => ({
  rank,
  title,
  detail,
  severity,
  frameIndex: 0,
  frameTimeSec: 0,
  unmentioned: true,
  status: "unmentioned" as const,
  mention: null,
  proofFrames: [{ frameIndex: 0, tSec: 0, box, caption }],
  category,
  ...(hazard ? { hazard } : {}),
});
const SAMPLE_META = { isExample: true } as const;

export const classroomSample: WorkPlan = {
  spaceName: "Vacant school classroom",
  generatedFrom: "SAMPLE: one stock photo, plan written by hand",
  frames: one("/examples/samples/classroom.webp"),
  inventory: [
    { label: "Ceiling light fixtures", count: 2, confidence: 0.7, method: "model", zone: "ceiling" },
    { label: "Doors", count: 1, confidence: 0.9, method: "model", zone: "back wall" },
    { label: "Low cabinets", count: 1, confidence: 0.6, method: "model", zone: "left wall" },
  ],
  issues: [
    { ...seen(1, "Ceiling grid open, tiles down and insulation hanging", "Most of the drop-ceiling tiles are missing or sagging, and batts of insulation hang from the grid. Anything still up there can fall. Keep people out until it's made safe.", "high", [0, 0, 1000, 260], "Open grid, hanging insulation", "safety"), tier: "urgent", area: "Ceiling, whole room", evidence: "Most drop-ceiling tiles gone, yellow insulation batts sagging through the open grid", checklistKey: "ceiling" },
    { ...seen(2, "Standing water and algae across the floor", "Water covers most of the floor with green growth at the edges, so there's an active leak or flooding. Slip hazard now, and the source has to be found before any repair.", "high", [0, 660, 1000, 1000], "Standing water, algae", "damage", "water_stain"), tier: "urgent", area: "Floor, wall to wall", evidence: "Water across the floor with green growth along the base of the block wall", checklistKey: "flooring" },
    { ...seen(3, "Fallen tiles and wet insulation on the floor", "Chunks of ceiling tile and insulation sit in the water. Wet insulation should be bagged and removed, not dried in place.", "medium", [330, 740, 610, 880], "Debris in the water", "damage"), tier: "soon", area: "Floor, front of the room", evidence: "Broken ceiling tile and a clump of insulation lying in the water", checklistKey: "clutter" },
    { ...seen(4, "Graffiti on the block walls", "Spray paint on two walls. Clean and prime with a stain-blocking primer before repainting, or it bleeds through.", "low", [790, 250, 1000, 600], "Spray paint", "cosmetic"), tier: "later", area: "Block walls, center and by the door", evidence: "Red spray-painted letter on the main wall, more paint on the wall through the door", checklistKey: "walls" },
  ],
  watch: [
    {
      title: "Wall box at the waterline",
      detail: "A small box sits on the block wall right at floor level, where the water reaches. If it is an outlet or junction box, keep power to the room off until an electrician checks it.",
      confidence: 0.38,
      frameIndex: 0,
      frameTimeSec: 0,
      area: "Base of the main wall, right of center",
      evidence: "Small grey box on the block wall just above the wet floor",
      checklistKey: "exposed_wiring",
    },
  ],
  materials: [
    { item: "Pump or wet-vac rental", qty: "1 day", forIssues: [2] },
    { item: "Contractor bags and N95 masks", qty: "1 box each", forIssues: [3] },
    { item: "2x2 ceiling tiles and grid parts", qty: "Measure on site", forIssues: [1] },
    { item: "Stain-blocking primer and block-wall paint", qty: "Measure on site", forIssues: [4] },
  ],
  workOrder: [
    { order: 1, title: "Make it safe", detail: "Shut off power to the room, tape off the door, and keep people out until the ceiling is checked.", fixes: [1], trade: "Facilities", hours: [1, 2] },
    { order: 2, title: "Find and stop the water", detail: "Trace the leak (roof, pipe or drain) and fix it before touching anything else.", dependsOn: 1, fixes: [2], trade: "Roofer or plumber", hours: [2, 8] },
    { order: 3, title: "Pump out and remove wet material", detail: "Pump the floor dry, bag wet insulation and tiles, and check for mold.", dependsOn: 2, fixes: [2, 3], trade: "Remediation crew", hours: [4, 8] },
    { order: 4, title: "Rebuild the ceiling", detail: "Repair the grid, replace insulation and tiles, and reinstall the lights.", dependsOn: 3, fixes: [1], trade: "Ceiling contractor", hours: [8, 16] },
    { order: 5, title: "Clean, prime and paint the walls", detail: "Scrub the graffiti, spot-prime with stain blocker, then two coats.", dependsOn: 4, fixes: [4], trade: "Volunteer", hours: [6, 10] },
  ],
  afterImageUrl: null,
  transcript: null,
  costRange: null,
  meta: { ...SAMPLE_META },
};

export const officeSample: WorkPlan = {
  spaceName: "Empty office before move-in",
  generatedFrom: "SAMPLE: one stock photo, plan written by hand",
  frames: one("/examples/samples/office.webp"),
  inventory: [
    { label: "Window sections", count: 4, confidence: 0.8, method: "model", zone: "outside wall" },
    { label: "Heater panels", count: 4, confidence: 0.75, method: "model", zone: "under windows" },
    { label: "Floor outlet covers", count: 2, confidence: 0.7, method: "model", zone: "floor" },
    { label: "Doors", count: 1, confidence: 0.9, method: "model", zone: "inside wall" },
    { label: "Planters", count: 1, confidence: 0.9, method: "model", zone: "corner" },
  ],
  issues: [
    { ...seen(1, "Check the door closer and latch", "The door has an overhead closer. On a fire-rated door it has to close and latch on its own. Test it before anyone moves in.", "medium", [225, 250, 320, 290], "Door closer", "safety", "egress"), tier: "soon", area: "Door on the inside wall", evidence: "Overhead closer arm at the top of the door; latch not visible in the photo", checklistKey: "doors_windows" },
    { ...seen(2, "Floor outlet covers in the walking path", "Two round floor-box covers sit where people will walk. Make sure each is flush and locked, or it's a trip point.", "medium", [265, 835, 735, 960], "Floor covers", "safety", "trip_cable"), tier: "soon", area: "Carpet in front of the door and the windows", evidence: "Two round metal floor-box lids set in the carpet in the walking path", checklistKey: "flooring" },
    { ...seen(3, "Dead tree dropping leaves", "The planted tree has died and is shedding across the floor. Remove it and the soil before it draws pests.", "low", [360, 150, 660, 840], "Dead tree", "cosmetic"), tier: "soon", area: "Corner planter by the windows", evidence: "Tree in the round planter with dry, curled leaves, many already on the floor", checklistKey: "cleanliness" },
    { ...seen(4, "Leaves and grit ground into the carpet", "Debris is spread across the carpet by the windows. Deep-clean once the tree is out.", "low", [300, 770, 1000, 950], "Debris on carpet", "cosmetic"), tier: "later", area: "Carpet along the window wall", evidence: "Dry leaves scattered over the carpet around the planter and under the heaters", checklistKey: "cleanliness" },
    { ...seen(5, "Dust on the heater panels", "Clean the panels and test each one before the heating season.", "low", [560, 570, 1000, 930], "Heater panels", "function"), tier: "later", area: "Under the windows", evidence: "Four flat heater panels on legs below the window sills", checklistKey: "hvac" },
  ],
  watch: [
    {
      title: "No blinds on a full wall of glass",
      detail: "Low sun comes straight through the floor-to-ceiling windows. Plan for blinds or film before desks go in, or screens will be hard to read.",
      confidence: 0.4,
      frameIndex: 0,
      frameTimeSec: 0,
      area: "Window wall",
      evidence: "Bright sun and hard shadows across the room, no blinds or shades in view",
      checklistKey: "doors_windows",
    },
  ],
  materials: [
    { item: "Carpet extractor rental", qty: "1 day", forIssues: [4] },
    { item: "Floor-box cover screws or replacement lid", qty: "As needed", forIssues: [2] },
    { item: "Trash bags and a hand truck", qty: "1 set", forIssues: [3] },
  ],
  workOrder: [
    { order: 1, title: "Test the door closer and latch", detail: "Open fully, let go, and confirm it closes and latches. Adjust or replace the closer if not.", fixes: [1], trade: "Facilities", hours: [0.5, 1] },
    { order: 2, title: "Secure the floor covers", detail: "Seat both covers flush and fasten them. Replace any lid that rocks.", fixes: [2], trade: "Electrician", hours: [0.5, 1] },
    { order: 3, title: "Remove the dead tree", detail: "Bag the tree and soil and take out the planter, or replant it.", fixes: [3], trade: "Volunteer", hours: [1, 2] },
    { order: 4, title: "Deep-clean the carpet", detail: "Vacuum, then hot-water extract the whole floor.", dependsOn: 3, fixes: [4], trade: "Volunteer", hours: [2, 3] },
    { order: 5, title: "Clean and test the heaters", detail: "Wipe the panels and turn each one on to check it heats.", fixes: [5], trade: "Facilities", hours: [1, 2] },
  ],
  afterImageUrl: null,
  transcript: null,
  costRange: null,
  meta: { ...SAMPLE_META },
};

export const warehouseSample: WorkPlan = {
  spaceName: "Warehouse floor",
  generatedFrom: "SAMPLE: one stock photo, plan written by hand",
  frames: one("/examples/samples/warehouse.webp"),
  inventory: [
    { label: "Pallet rack runs", count: 1, confidence: 0.85, method: "model", zone: "back wall" },
    { label: "Vehicles stored inside", count: 2, confidence: 0.85, method: "model", zone: "floor" },
    { label: "Rolling scaffold towers", count: 4, confidence: 0.6, method: "model", zone: "front right" },
  ],
  issues: [
    { ...seen(1, "Materials parked in the main drive aisle", "Lumber, panels and carts sit in the center aisle, so a forklift or a person can't get through cleanly. Keep main aisles clear.", "high", [430, 620, 640, 1000], "Blocked aisle", "safety", "egress"), tier: "urgent", area: "Center drive aisle", evidence: "Lumber, panels and a cart standing in the middle aisle between the two storage rows", checklistKey: "blocked_aisle" },
    { ...seen(2, "Long stock laid loose on the floor", "Long boards and pipe lie across the floor along the left side. Trip hazard, and they get run over. Rack them.", "medium", [50, 560, 200, 1000], "Loose long stock", "safety", "trip_cable"), tier: "soon", area: "Left side, along the platform", evidence: "Long boards and pipe lying loose on the floor beside the raised platform", checklistKey: "clutter" },
    { ...seen(3, "Scaffold frames stacked upright and unbraced", "Tall scaffold frames stand loose near the right aisle. Lay them flat or strap them so they can't tip.", "medium", [740, 640, 980, 940], "Upright frames", "safety"), tier: "urgent", area: "Front right, by the aisle", evidence: "Tall scaffold frames standing upright near the right aisle with no straps visible", checklistKey: "clutter" },
    { ...seen(4, "Check the pallet rack for damage and beam locks", "Inspect uprights for dents and make sure every beam has its safety lock before loading.", "medium", [550, 160, 780, 350], "Pallet rack", "function"), tier: "soon", area: "Back wall, orange rack", evidence: "Orange pallet rack against the back wall; beam locks too small to check in the photo", checklistKey: "clutter" },
    { ...seen(5, "No floor lines marking aisles and storage zones", "Painted lines keep aisles clear by showing where storage stops.", "low", [300, 420, 470, 620], "Unmarked floor", "function"), tier: "later", area: "Main floor", evidence: "Bare concrete floor with no painted aisle or zone lines anywhere in view", checklistKey: "flooring" },
  ],
  watch: [
    {
      title: "Loose stair units parked between the piles",
      detail: "Freestanding steel stair units sit on the open floor. Check that the wheels lock and that nobody uses them as a work platform without rails.",
      confidence: 0.37,
      frameIndex: 0,
      frameTimeSec: 0,
      area: "Center of the floor, between the stock piles",
      evidence: "Steel stair units standing on their own on the floor among the stored materials",
      checklistKey: "steps",
    },
  ],
  materials: [
    { item: "Cantilever rack for long stock", qty: "1 section", forIssues: [2] },
    { item: "Ratchet straps", qty: "6", forIssues: [3] },
    { item: "Rack beam safety locks", qty: "As needed", forIssues: [4] },
    { item: "Floor marking tape or paint, yellow", qty: "Measure on site", forIssues: [5] },
  ],
  workOrder: [
    { order: 1, title: "Clear the main aisle", detail: "Move everything out of the drive aisle to a marked holding spot.", fixes: [1], trade: "Warehouse crew", hours: [2, 4] },
    { order: 2, title: "Strap or lay down the scaffold frames", detail: "Lay frames flat on dunnage or strap them to a fixed point.", fixes: [3], trade: "Warehouse crew", hours: [1, 2] },
    { order: 3, title: "Rack the long stock", detail: "Put up a cantilever rack and move boards and pipe onto it.", dependsOn: 1, fixes: [2], trade: "Warehouse crew", hours: [3, 6] },
    { order: 4, title: "Inspect the pallet rack", detail: "Check uprights and beams, add missing locks, and tag any damaged part out of use.", fixes: [4], trade: "Rack inspector", hours: [1, 3] },
    { order: 5, title: "Mark aisles and zones", detail: "Lay yellow lines for aisles and storage zones once the floor is clear.", dependsOn: 3, fixes: [5], trade: "Warehouse crew", hours: [3, 5] },
  ],
  afterImageUrl: null,
  transcript: null,
  costRange: null,
  meta: { ...SAMPLE_META },
};
