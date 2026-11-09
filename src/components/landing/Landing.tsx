import Image from "next/image";
import Link from "next/link";
import { LastPlanLink } from "./LastPlanLink";

const ring = "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";
const primary = `inline-flex min-h-[44px] items-center justify-center rounded-xl bg-accent-dark px-6 py-3 text-base font-semibold text-white hover:bg-ink ${ring}`;
const steps = [
  {
    title: "Film.",
    body: "Walk the space slowly, edge to edge. Say what needs work if you like. A silent walkthrough works too.",
  },
  {
    title: "SightWork looks.",
    body: "It listens to what you said, studies your walkthrough, counts what's in the room, and checks what you said against what it saw.",
  },
  {
    title: "Get your plan.",
    body: "Usually in a few minutes: problems ranked worst first, each with a proof frame from your video, then the steps in the right order and the materials.",
  },
];

/** Said-vs-saw strip from the featured SAMPLE plan (src/lib/examples/kitchen.ts): CC0 photos, hand-written plan. */
const matched = [
  { said: "Ceiling's opened up here, we'll need new drywall over all of this.", saw: "Loose plaster and lath hanging overhead" },
  { said: "The fireplace front is cracked, I want that fixed.", saw: "Facade split at the top corner" },
];

/**
 * "What you get". The cost line and the after-picture tile are left out on purpose: the agreed copy
 * shows them only if the cost step and Muse Image actually run.
 */
const gets = [
  { title: "Problems, worst first.", body: "Safety items rise to the top, each with the frame and second where it shows." },
  { title: "What you said vs. what we saw.", body: "Every request matched to the video, plus anything you missed." },
  { title: "Counts.", body: "Fixtures, furniture, equipment and more, counted from the video as an approximate range." },
  { title: "Work steps in order.", body: "Fix the leak before the ceiling tile. Who does it, about how long, and what it fixes." },
  { title: "Materials.", body: "A shopping list for the work." },
  { title: "Ready for work day.", body: "Tick steps off as they're done, send the plan to your team, add the steps to a calendar, or have it read aloud where your browser can speak." },
];

const audiences = [
  { title: "Facilities and property teams.", body: "A consistent first look at any room, with photos attached." },
  { title: "Small contractors and handypeople.", body: "Scope a job from a walkthrough before you price it." },
  { title: "Schools and campuses.", body: "Classrooms, gyms and auditoriums checked before the next term." },
  { title: "Churches and nonprofits.", body: "Turn a walkthrough into a volunteer work-day list." },
];

/** The Meta models in the pipeline, in the order a run uses them. The featured real run (Oct 29) used SAM 3.1, Muse Spark Open and Muse Image; Transcribe runs when the video has speech. */
const metaModels = [
  { step: "Listen", name: "Muse Voice Transcribe", role: "Turns what you say on the walkthrough into text, with timestamps." },
  { step: "Look and count", name: "SAM 3.1", role: "Outlines and counts what's in the room, frame by frame." },
  { step: "Compare, plan, review", name: "Muse Spark Open", role: "Checks what you said against what it saw, writes the plan, then reviews every problem against its photo. Meta open weights, on Baseten." },
  { step: "Picture", name: "Muse Image", role: "Draws an AI concept of the finished space." },
];

/** Impact strip. Every number is from real runs on the live site (Oct 29 to Nov 3, 2026). */
const impact = [
  { value: "1 minute", label: "of phone video is all it takes" },
  { value: "About 3 min", label: "from upload to a full plan, in real runs" },
  { value: "About $1", label: "in model calls per plan ($0.38 to $1.10 in real runs, most with live prices)" },
  { value: "0", label: "accounts, apps or site visits needed for the first look" },
];

/** Fine print. Cost and after-picture lines join only if those steps run. */
const finePrint = [
  "Counts are approximate, from what the camera saw.",
  "Your video's frames and narration are sent to the AI providers to build your plan, and we don't keep a copy on our servers. The finished plan is saved on your device.",
];

const secondary = `inline-flex min-h-[44px] items-center justify-center rounded-xl border border-ink/20 bg-white/60 px-6 py-3 text-base font-semibold text-ink hover:border-ink/40 ${ring}`;

/**
 * Landing page at /. Static server component, no client JS.
 * Copy is word for word from the agreed Conclusion in the design doc: header, hero, how it works,
 * the said-vs-saw band, what you get, who it's for, built on Meta's models, fine print,
 * closing CTA and footer.
 */
export function Landing() {
  return (
    <>
      <header className="border-b border-ink/10 pt-[env(safe-area-inset-top)]">
        <div className="mx-auto flex min-h-14 w-full max-w-5xl items-center justify-between gap-3 px-4 sm:px-6">
          <a href="#top" className={`-mx-2 flex min-h-11 items-center rounded-lg px-2 text-xl font-extrabold tracking-tight ${ring}`}>
            Sight<span className="text-accent">Work</span>
          </a>
          <Link href="/start" className={`min-h-11 rounded-full border border-ink/20 bg-white/60 px-4 py-2.5 text-sm font-semibold hover:border-ink/40 ${ring}`}>
            Try it
          </Link>
        </div>
      </header>

      <main id="top">
        <span id="main-content" tabIndex={-1} className="block outline-none" />
        <section className="mx-auto grid w-full max-w-5xl items-center gap-12 px-4 pb-16 pt-12 sm:px-6 md:pt-16 lg:grid-cols-[minmax(0,1fr)_minmax(0,440px)] lg:gap-14">
          <div>
          <h1 className="max-w-2xl text-[32px] font-extrabold leading-tight tracking-tight sm:text-4xl lg:text-5xl">
            Walk the room. Get the work plan.
          </h1>
          <p className="mt-5 max-w-2xl text-lg leading-relaxed text-ink/75">
            Film a walkthrough on your phone, from 30 seconds for a small room to 5 minutes for a warehouse. SightWork counts what&apos;s there, roughly, finds what needs fixing,
            including the problems you didn&apos;t mention, and lays out the work in order, with proof from your own video.
          </p>
          <div className="mt-8 flex flex-col gap-3 sm:flex-row">
            <Link href="/start" className={primary}>Film a walkthrough</Link>
            <Link href="/start?view=example&ex=sanctuary" className={secondary}>See a real run</Link>
          </div>
          <LastPlanLink />
          <p className="mt-4 text-sm text-ink/70">Open source. No account needed to try an example plan.</p>
          </div>
          <RealRunHero />
        </section>

        <section aria-labelledby="impact-heading" className="border-t border-ink/10 bg-ink text-white">
          <div className="mx-auto w-full max-w-5xl px-4 py-12 sm:px-6 md:py-14">
            <h2 id="impact-heading" className="max-w-3xl text-[28px] font-extrabold leading-tight">
              Most churches, schools and nonprofits have no facilities staff. They have volunteers and a phone.
            </h2>
            <p className="mt-4 max-w-2xl text-lg leading-relaxed text-white/80">
              SightWork turns a walkthrough into a plan a volunteer team can pick up on work day: what to fix first, who does it, what to buy,
              and proof from the video, ready to share or print.
            </p>
            <dl className="mt-8 grid grid-cols-2 gap-x-6 gap-y-6 lg:grid-cols-4">
              {impact.map((m) => (
                <div key={m.label} className="border-l-2 border-accent pl-4">
                  <dt className="sr-only">{m.label}</dt>
                  <dd>
                    <span className="block text-3xl font-extrabold tracking-tight">{m.value}</span>
                    <span className="mt-1 block text-sm leading-snug text-white/75">{m.label}</span>
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        </section>

        <section aria-labelledby="how-heading" className="border-t border-ink/10">
          <div className="mx-auto w-full max-w-5xl px-4 py-12 sm:px-6 md:py-16">
            <h2 id="how-heading" className="text-[28px] font-extrabold leading-tight">How it works</h2>
            <ol className="mt-6 grid gap-4 md:grid-cols-3">
              {steps.map((step, i) => (
                <li key={step.title} className="rounded-2xl border border-ink/10 bg-white p-5">
                  <span
                    aria-hidden="true"
                    className="flex h-9 w-9 items-center justify-center rounded-full bg-accent-dark text-base font-bold text-white"
                  >
                    {i + 1}
                  </span>
                  <h3 className="mt-4 text-lg font-bold">
                    <span className="sr-only">Step {i + 1}: </span>
                    {step.title}
                  </h3>
                  <p className="mt-2 text-base leading-relaxed text-ink/75">{step.body}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section aria-labelledby="catch-heading" className="border-t border-ink/10 bg-white">
          <div className="mx-auto w-full max-w-5xl px-4 py-12 sm:px-6 md:py-16">
            <h2 id="catch-heading" className="max-w-2xl text-[28px] font-extrabold leading-tight">
              You mention three things. SightWork finds three more.
            </h2>
            <ul className="mt-6 grid gap-3">
              {matched.map((row) => (
                <li
                  key={row.said}
                  className="grid gap-2 rounded-2xl border border-ink/10 bg-paper p-4 sm:grid-cols-2 sm:items-center sm:gap-6"
                >
                  <p className="text-base">
                    <span className="block text-xs font-semibold uppercase tracking-wide text-ink/70">You said</span>
                    &ldquo;{row.said}&rdquo;
                  </p>
                  <p className="text-base">
                    <span className="block text-xs font-semibold uppercase tracking-wide text-ink/70">SightWork saw</span>
                    {row.saw}
                  </p>
                </li>
              ))}
              <li className="rounded-2xl border border-accent-dark/30 border-l-4 border-l-accent-dark bg-paper p-4">
                <p className="text-base font-bold">
                  <span className="block text-xs font-semibold uppercase tracking-wide text-accent-dark">Not mentioned</span>
                  Shutoff valve under the sink is leaking.
                </p>
              </li>
            </ul>
            <p className="mt-4 text-sm text-ink/70">Sample plan on free-to-use (CC0) photos of a real kitchen renovation. The narration and plan are written by hand to show the format.</p>
          </div>
        </section>

        <section aria-labelledby="get-heading" className="border-t border-ink/10">
          <div className="mx-auto w-full max-w-5xl px-4 py-12 sm:px-6 md:py-16">
            <h2 id="get-heading" className="text-[28px] font-extrabold leading-tight">What you get</h2>
            <ul className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {gets.map((item) => (
                <li key={item.title} className="rounded-2xl border border-ink/10 bg-white p-5">
                  <h3 className="text-lg font-bold">{item.title}</h3>
                  <p className="mt-2 text-base leading-relaxed text-ink/75">{item.body}</p>
                </li>
              ))}
            </ul>
            <p className="mt-6 text-base text-ink/75">Plus: save the whole plan as a PDF to share with your team.</p>
          </div>
        </section>

        <section aria-labelledby="who-heading" className="border-t border-ink/10 bg-white">
          <div className="mx-auto w-full max-w-5xl px-4 py-12 sm:px-6 md:py-16">
            <h2 id="who-heading" className="text-[28px] font-extrabold leading-tight">Who it&apos;s for</h2>
            <ul className="mt-6 grid gap-4 sm:grid-cols-2">
              {audiences.map((item) => (
                <li key={item.title} className="rounded-2xl border border-ink/10 bg-paper p-5">
                  <h3 className="text-lg font-bold">{item.title}</h3>
                  <p className="mt-2 text-base leading-relaxed text-ink/75">{item.body}</p>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section aria-labelledby="meta-heading" className="border-t border-ink/10">
          <div className="mx-auto w-full max-w-5xl px-4 py-12 sm:px-6 md:py-16">
            <h2 id="meta-heading" className="text-[28px] font-extrabold leading-tight">Built on Meta&apos;s models</h2>
            <p className="mt-4 max-w-2xl text-lg leading-relaxed text-ink/75">
              Four Meta models, one job each, chained into one agent run. Every plan ends with a &ldquo;Powered by Meta AI&rdquo; panel
              that says which model did each step and whether it ran.
            </p>
            <ol className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {metaModels.map((m, i) => (
                <li key={m.name} className="relative rounded-2xl border border-ink/10 bg-white p-5">
                  <span className="text-xs font-semibold uppercase tracking-wide text-[#0866ff]">
                    {i + 1}. {m.step}
                  </span>
                  <h3 className="mt-1 text-lg font-bold">{m.name}</h3>
                  <p className="mt-2 text-base leading-relaxed text-ink/75">{m.role}</p>
                </li>
              ))}
            </ol>
            <p className="mt-6 text-sm text-ink/70">
              Live config and safeguards: <Link href="/status" className="underline underline-offset-2 hover:text-ink">status page</Link>.
            </p>
          </div>
        </section>

        <section aria-labelledby="fine-heading" className="border-t border-ink/10 bg-white">
          <div className="mx-auto w-full max-w-5xl px-4 py-12 sm:px-6 md:py-16">
            <h2 id="fine-heading" className="text-[28px] font-extrabold leading-tight">The honest fine print</h2>
            <ul className="mt-6 grid max-w-2xl list-disc gap-3 pl-5 text-base leading-relaxed text-ink/75 marker:text-ink/50">
              {finePrint.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>
        </section>

        <section className="bg-ink text-white">
          <div className="mx-auto w-full max-w-5xl px-4 py-16 sm:px-6">
            <h2 className="text-[28px] font-extrabold leading-tight">Your next walkthrough could be a work plan.</h2>
            <p className="mt-4 max-w-xl text-lg text-white/80">
              Grab your phone, walk the space for a minute, and see what SightWork finds.
            </p>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <Link
                href="/start"
                className="inline-flex min-h-[44px] items-center justify-center rounded-xl bg-white px-6 py-3 text-base font-semibold text-ink hover:bg-paper focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
              >
                Film a walkthrough
              </Link>
              <Link
                href="/start?view=example"
                className="inline-flex min-h-[44px] items-center justify-center rounded-xl border border-white/40 px-6 py-3 text-base font-semibold text-white hover:border-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
              >
                See an example plan
              </Link>
            </div>
          </div>
        </section>
      </main>

      <footer className="mx-auto flex w-full max-w-5xl flex-wrap items-center justify-between gap-3 px-4 py-8 text-sm text-ink/70 sm:px-6">
        <span>SightWork · open source · built by Antonio James</span>
        <nav aria-label="Site" className="flex gap-4">
          <Link href="/status" className={`underline underline-offset-2 hover:text-ink ${ring}`}>Status</Link>
          <Link href="/credits" className={`underline underline-offset-2 hover:text-ink ${ring}`}>Image credits</Link>
        </nav>
      </footer>
    </>
  );
}

/**
 * Hero visual: the REAL sanctuary run (src/lib/examples/sanctuary-walk-run.json), the walkthrough frame the after picture was
 * drawn from next to Muse Image's after picture, with that run's own numbers. Labeled "Real run"; the after picture is
 * labeled as an AI concept, as on the plan screen.
 */
function RealRunHero() {
  return (
    <figure className="relative mx-auto w-full max-w-[440px]">
      <div className="overflow-hidden rounded-3xl border border-ink/10 bg-white shadow-2xl shadow-ink/15">
        <div className="grid grid-cols-2 gap-px bg-ink/10">
          <div className="relative bg-ink">
            <Image
              src="/examples/sanctuary-walk/f47.webp"
              alt="Frame from a real walkthrough of a church sanctuary stage: a dark stage edge with no marking, cables on the floor."
              width={576}
              height={1024}
              sizes="(min-width: 1024px) 220px, 50vw"
              priority
              className="aspect-[4/5] h-full w-full object-cover"
            />
            <span className="absolute left-2 top-2 rounded-full bg-ink/85 px-2 py-0.5 text-xs font-semibold text-white">Before</span>
          </div>
          <div className="relative bg-ink">
            <Image
              src="/examples/sanctuary-walk/after.webp"
              alt="AI concept of the same stage after the work: cables cleared, the floor refinished and the stage edge and steps marked."
              width={1280}
              height={853}
              sizes="(min-width: 1024px) 220px, 50vw"
              priority
              className="aspect-[4/5] h-full w-full object-cover"
            />
            <span className="absolute left-2 top-2 rounded-full bg-ink/85 px-2 py-0.5 text-xs font-semibold text-white">After, AI concept</span>
          </div>
        </div>
        <div className="p-4 sm:p-5">
          <p className="flex items-center gap-2 text-sm font-semibold">
            <span className="shrink-0 whitespace-nowrap rounded-full bg-safe-dark px-2 py-0.5 text-xs font-bold uppercase tracking-wide text-white">Real run</span>
            Church sanctuary stage, 2:28 video
          </p>
          <dl className="mt-3 grid grid-cols-3 gap-3 text-center">
            {[
              ["6", "problems, worst first"],
              ["69", "chairs counted"],
              ["$1.08", "in model calls"],
            ].map(([v, l]) => (
              <div key={l} className="rounded-xl bg-paper px-2 py-2.5">
                <dt className="sr-only">{l}</dt>
                <dd>
                  <span className="block text-2xl font-extrabold tracking-tight">{v}</span>
                  <span className="block text-xs leading-tight text-ink/70">{l}</span>
                </dd>
              </div>
            ))}
          </dl>
          <p className="mt-3 text-sm text-ink/75">
            <span className="font-semibold text-ink">Top problem:</span> loose cables across the stage floor, a trip hazard.
          </p>
        </div>
      </div>
      <figcaption className="mt-3 text-center text-sm text-ink/70">
        <Link href="/start?view=example&ex=sanctuary" className={`font-semibold text-accent-dark underline underline-offset-2 ${ring}`}>
          Open this real plan
        </Link>{" "}
        · nothing edited except a covered logo
      </figcaption>
    </figure>
  );
}
