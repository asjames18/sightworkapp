/**
 * The examples on /start. One real SightWork run (the featured card) and a few hand-written samples on
 * free stock photos. Every example says which it is: "real" plans came from the pipeline unchanged except
 * for image hosting and a covered logo; "sample" plans are illustrative and never claim a model ran.
 */
import type { WorkPlan } from "../types";
import sanctuaryRun from "./sanctuary-walk-run.json";
import { classroomSample, officeSample, warehouseSample } from "./samples";
import { kitchenSample } from "./kitchen";
import { withFrameSizes } from "./frameSizes";
import { withPrecomputedReview } from "../review";

export type ExampleKind = "real" | "sample";

export interface Example {
  id: string;
  kind: ExampleKind;
  /** Card title, e.g. "Church sanctuary stage". */
  title: string;
  /** One line under the title on the card. */
  blurb: string;
  thumb: string;
  plan: WorkPlan;
  /** Shown on the plan's banner. */
  banner: string;
  /** Photo credit for samples (license and source page). */
  credit?: { author: string; license: string; url: string };
}

/**
 * Real run, Nov 3, 2026, 4:05 PM ET, on the 2:28 walkthrough filmed Nov 2: frames and after picture re-hosted as files,
 * church logo covered. It went through the reviewer, so its proof check is the model's own (review.source "model").
 */
const sanctuaryPlan = withFrameSizes({ ...(sanctuaryRun as unknown as WorkPlan) });

export const EXAMPLES: Example[] = [
  {
    id: "kitchen",
    kind: "sample",
    title: "Older home kitchen renovation",
    blurb: "45-second walkthrough. 6 problems, 3 you didn't mention, 8 steps in order.",
    thumb: "/examples/kitchen/f1.webp",
    plan: withFrameSizes(kitchenSample),
    banner:
      "Sample plan written by hand on 7 stock photos from one kitchen renovation, with a sample narration, to show what a plan looks like. Not a SightWork run.",
    credit: { author: "Tomwsulcer", license: "CC0", url: "https://commons.wikimedia.org/wiki/User:Tomwsulcer" },
  },
  {
    id: "sanctuary",
    kind: "real",
    title: "Church sanctuary stage",
    blurb: "A real run on a 2½-minute walkthrough: 6 problems, 69 chairs counted, each problem checked against its photo.",
    thumb: "/examples/thumbs/sanctuary-walk.webp",
    plan: sanctuaryPlan,
    banner:
      "Real SightWork run from a 2-minute 28-second narrated walkthrough filmed Nov 2, 2026. Muse Voice Transcribe wrote down the narration, SAM counted the room, Muse Spark Open wrote the plan and checked each problem against its photo, Muse Spark priced it for Sebring, FL, and Muse Image drew the after picture, in about 4 minutes for $1.08 in model calls. Nothing here was edited except covering the church logo.",
  },
  {
    id: "classroom",
    kind: "sample",
    title: "Vacant school classroom",
    blurb: "Ceiling down, standing water: what to make safe first.",
    thumb: "/examples/thumbs/classroom.webp",
    plan: withFrameSizes(classroomSample),
    banner: "Sample plan written by hand on one stock photo, to show the format for a classroom. Not a SightWork run.",
    credit: { author: "Warren LeMay", license: "CC0", url: "https://commons.wikimedia.org/wiki/File:Classroom,_Log_Cabin_Association_Elementary_School,_Barkers_Creek,_NC_(46649210201).jpg" },
  },
  {
    id: "office",
    kind: "sample",
    title: "Empty office before move‑in",
    blurb: "Door closer, floor covers and cleanup in the right order.",
    thumb: "/examples/thumbs/office.webp",
    plan: withFrameSizes(officeSample),
    banner: "Sample plan written by hand on one stock photo, to show the format for an office. Not a SightWork run.",
    credit: { author: "Sam X (Unsplash)", license: "CC0", url: "https://commons.wikimedia.org/wiki/File:Neglected_office_plants_(Unsplash).jpg" },
  },
  {
    id: "warehouse",
    kind: "sample",
    title: "Warehouse floor",
    blurb: "Blocked aisles, loose stock and rack checks.",
    thumb: "/examples/thumbs/warehouse.webp",
    plan: withFrameSizes(warehouseSample),
    banner: "Sample plan written by hand on one stock photo, to show the format for a warehouse. Not a SightWork run.",
    credit: { author: "Charly Birdsinger (Unsplash)", license: "CC0", url: "https://commons.wikimedia.org/wiki/File:Industrial_storage_area_(Unsplash).jpg" },
  },
];

// Every example without its own review gets a precomputed proof check (src/lib/review.ts): it records only whether each
// problem points at a real proof photo, says it was worked out ahead of time, and never claims a model reviewed it.
// The real sanctuary run keeps the review its run returned.
for (const e of EXAMPLES) e.plan = withPrecomputedReview(e.plan);

export const FEATURED_EXAMPLE = EXAMPLES[0];

export function findExample(id: string | null | undefined): Example {
  return EXAMPLES.find((e) => e.id === id) ?? FEATURED_EXAMPLE;
}
