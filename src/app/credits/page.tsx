import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Example image credits | SightWork",
  description: "Where the photos in SightWork's example plans come from, and their licenses.",
};

const kitchen = [
  ["f0", "Demolition_project_kitchen_about_to_undergo_renovation.JPG"],
  ["f1", "Demolition_project_opening_up_the_ceiling_plaster_and_lath_partially_removed.JPG"],
  ["f2", "Ceiling_sheetrock_damaged_by_water_so_paint_was_peeling.jpg"],
  ["f3", "Kitchen_renovation_leaky_valve_beneath_kitchen_sink.JPG"],
  ["f4", "Kitchen_renovation_view_of_bathtub_pipes_in_ceiling_of_9a.JPG"],
  ["f5", "Demolition_project_removing_plaster_and_lath_walls_to_expose_bare_bricks.JPG"],
  ["f6", "Kitchen_renovation_fireplace_repair_project.JPG"],
].map(([id, file]) => ({ img: `/examples/kitchen/${id}.webp`, url: `https://commons.wikimedia.org/wiki/File:${file}`, author: "Tomwsulcer" }));

const samples = [
  {
    img: "/examples/samples/classroom.webp",
    title: "Vacant school classroom",
    url: "https://commons.wikimedia.org/wiki/File:Classroom,_Log_Cabin_Association_Elementary_School,_Barkers_Creek,_NC_(46649210201).jpg",
    author: "Warren LeMay",
    note: "left edge cropped",
  },
  {
    img: "/examples/samples/office.webp",
    title: "Empty office before move-in",
    url: "https://commons.wikimedia.org/wiki/File:Neglected_office_plants_(Unsplash).jpg",
    author: "Sam X (via Unsplash)",
  },
  {
    img: "/examples/samples/warehouse.webp",
    title: "Warehouse floor",
    url: "https://commons.wikimedia.org/wiki/File:Industrial_storage_area_(Unsplash).jpg",
    author: "Charly Birdsinger (via Unsplash)",
  },
];

const link = "underline underline-offset-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

/** Credits for the example images (same facts as public/examples/CREDITS.md), as a readable page instead of raw Markdown. */
export default function Credits() {
  return (
    <>
      <header className="border-b border-ink/10 pt-[env(safe-area-inset-top)]">
        <div className="mx-auto flex min-h-14 w-full max-w-3xl items-center justify-between gap-3 px-4 sm:px-6">
          <Link
            href="/"
            className="-mx-2 flex min-h-11 items-center rounded-lg px-2 text-xl font-extrabold tracking-tight focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            Sight<span className="text-accent">Work</span>
          </Link>
          <Link href="/start" className="btn-secondary text-sm">
            Back to the app
          </Link>
        </div>
      </header>
      <main id="main-content" tabIndex={-1} className="outline-none mx-auto w-full max-w-3xl px-4 pb-16 pt-10 sm:px-6">
        <h1 className="text-3xl font-extrabold tracking-tight">Example image credits</h1>
        <p className="mt-3 text-base text-ink/75">
          The sample plans are written by hand on free-to-use photos, to show what a plan looks like. They are not SightWork runs. The one real run
          uses frames from our own walkthrough video.
        </p>

        <section aria-labelledby="real-heading" className="mt-10">
          <h2 id="real-heading" className="text-xl font-extrabold">Real run: church sanctuary stage</h2>
          <p className="mt-2 text-sm text-ink/75">
            Frames and the AI after picture come from a real SightWork run on a walkthrough the SightWork team filmed in a church sanctuary on
            Oct 29, 2026, with the church&apos;s permission. The logo on the pulpit is covered in every frame. Not for reuse.
          </p>
        </section>

        <section aria-labelledby="kitchen-heading" className="mt-10">
          <h2 id="kitchen-heading" className="text-xl font-extrabold">Featured sample: older home kitchen renovation</h2>
          <p className="mt-2 text-sm text-ink/75">Seven photos of one renovation, all CC0 1.0 by Tomwsulcer on Wikimedia Commons. Resized and converted to WebP.</p>
          <ul className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
            {kitchen.map((k, i) => (
              <li key={k.img} className="overflow-hidden rounded-xl bg-white ring-1 ring-ink/10">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={k.img} alt="" width={320} height={240} loading="lazy" className="block aspect-[4/3] w-full object-cover" />
                <p className="p-2 text-sm">
                  <a href={k.url} className={link} target="_blank" rel="noopener noreferrer">
                    Photo {i + 1} on Wikimedia Commons
                  </a>
                </p>
              </li>
            ))}
          </ul>
        </section>

        <section aria-labelledby="samples-heading" className="mt-10">
          <h2 id="samples-heading" className="text-xl font-extrabold">Other samples</h2>
          <p className="mt-2 text-sm text-ink/75">All CC0 1.0: public domain, free for any use, no attribution required. We credit the authors anyway.</p>
          <ul className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
            {samples.map((s) => (
              <li key={s.img} className="overflow-hidden rounded-xl bg-white ring-1 ring-ink/10">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={s.img} alt="" width={320} height={240} loading="lazy" className="block aspect-[4/3] w-full object-cover" />
                <div className="p-3 text-sm">
                  <p className="font-semibold">{s.title}</p>
                  <p className="mt-1 text-ink/75">
                    By {s.author}
                    {s.note ? `, ${s.note}` : ""}.{" "}
                    <a href={s.url} className={link} target="_blank" rel="noopener noreferrer">
                      Source
                    </a>
                  </p>
                </div>
              </li>
            ))}
          </ul>
        </section>

        <p className="mt-10 text-sm text-ink/75">
          License text:{" "}
          <a href="https://creativecommons.org/publicdomain/zero/1.0/" className={link} target="_blank" rel="noopener noreferrer">
            CC0 1.0 Universal
          </a>
          .
        </p>
      </main>
    </>
  );
}
