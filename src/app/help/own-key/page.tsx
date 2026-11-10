import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { byokEnabled } from "@/lib/client/byokKey";

export const metadata: Metadata = {
  title: "How to use your own Meta API key | SightWork",
  description: "Step by step: get a Meta Model API key, add it to SightWork, check it works, and keep it safe.",
  robots: { index: false },
};

const link = "underline underline-offset-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

const META_AUTH = "https://dev.meta.ai/docs/authentication";
const META_QUICKSTART = "https://dev.meta.ai/docs/quickstart";
const META_PRICING = "https://dev.meta.ai/docs/pricing-rate-limits";

function Ext({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a href={href} className={link} target="_blank" rel="noopener noreferrer">
      {children}
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <li className="rounded-2xl bg-white p-4 ring-1 ring-ink/10 sm:p-6">
      <h3 className="flex items-start gap-3 text-lg font-extrabold">
        <span aria-hidden="true" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent-dark text-sm text-white">
          {n}
        </span>
        <span className="pt-0.5">
          <span className="sr-only">Step {n}: </span>
          {title}
        </span>
      </h3>
      <div className="mt-3 space-y-2 text-base text-ink/80">{children}</div>
    </li>
  );
}

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section aria-labelledby={id} className="mt-12">
      <h2 id={id} className="text-2xl font-extrabold tracking-tight">
        {title}
      </h2>
      <div className="mt-4">{children}</div>
    </section>
  );
}

/** Beginner how-to for bring your own key. Hidden (404) until NEXT_PUBLIC_SIGHTWORK_BYOK is "on", like /settings. */
export default function OwnKeyHelp() {
  if (!byokEnabled()) notFound();
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
          <Link href="/settings" className="btn-secondary text-sm">
            Go to Settings
          </Link>
        </div>
      </header>
      <main id="main-content" tabIndex={-1} className="outline-none mx-auto w-full max-w-3xl px-4 pb-16 pt-10 sm:px-6">
        <h1 className="text-3xl font-extrabold tracking-tight">How to use your own Meta API key</h1>
        <p className="mt-3 text-base text-ink/80">
          SightWork is free when you use your own key from Meta. This guide takes about 10 minutes. You don&apos;t need to
          know how to code.
        </p>

        <div className="mt-6 rounded-2xl bg-accent/10 p-4 text-base sm:p-6" data-testid="own-key-billing">
          <p className="font-semibold">Who pays for what</p>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-ink/80">
            <li>With your own key, you pay Meta directly for the model use your plans need. SightWork doesn&apos;t cover it or bill you for it.</li>
            <li>Don&apos;t want to deal with a key? Paid SightWork plans will run on SightWork&apos;s own access, so you won&apos;t need one.</li>
          </ul>
        </div>

        <nav aria-label="On this page" className="mt-8">
          <p className="text-sm font-semibold text-ink/75">On this page</p>
          <ul className="mt-2 flex flex-wrap gap-2 text-sm">
            {[
              ["#get-key", "Get a key"],
              ["#add-key", "Add it to SightWork"],
              ["#check-key", "Check it works"],
              ["#change-key", "Remove or replace it"],
              ["#safe-key", "Keep it safe"],
              ["#tips", "Tips for a good plan"],
              ["#cost", "What it costs"],
            ].map(([href, label]) => (
              <li key={href}>
                <a href={href} className="inline-flex min-h-11 items-center rounded-full px-3 ring-1 ring-ink/15 hover:bg-ink/5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
                  {label}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        <Section id="get-key" title="1. Get a key from Meta">
          <p className="text-base text-ink/80">
            SightWork uses the <strong>Meta Model API</strong> (the Muse and SAM models at api.meta.ai). One key covers every
            model SightWork uses.
          </p>
          <ol className="mt-4 space-y-4">
            <Step n={1} title="Sign in to Meta's developer site">
              <p>
                Go to <Ext href="https://dev.meta.ai">dev.meta.ai</Ext> and log in to the Model API dashboard. If Meta asks you
                to set up an account or add a way to pay, follow its steps. Use is pay-as-you-go.
              </p>
            </Step>
            <Step n={2} title="Create a key">
              <p>
                Open the <strong>API keys</strong> tab and click <strong>Create API key</strong>. Give it a name you&apos;ll
                recognize, like &ldquo;SightWork&rdquo;, then click <strong>Create</strong>.
              </p>
            </Step>
            <Step n={3} title="Copy it right away">
              <p>
                Meta shows the key only once, so copy it now. A real key starts with <code className="font-mono">LLM_</code>{" "}
                followed by numbers, an underscore and a long string of letters and numbers.
              </p>
              <p className="text-sm">
                Meta&apos;s own steps: <Ext href={META_AUTH}>Authentication (get an API key)</Ext>.
              </p>
            </Step>
          </ol>
        </Section>

        <Section id="add-key" title="2. Add it to SightWork">
          <ol className="space-y-4">
            <Step n={4} title="Open Settings">
              <p>
                Open <Link href="/settings" className={link}>Settings</Link> on the phone or computer you&apos;ll use to make plans.
              </p>
            </Step>
            <Step n={5} title="Paste and save">
              <p>
                Under <strong>Use your own Meta API key</strong>, paste the key into the <strong>Meta API key</strong> box and
                press <strong>Save key</strong>.
              </p>
              <p>
                Paste only the key. If you copied extra words or quotes, SightWork tidies them, and it tells you in plain words
                if something still looks wrong.
              </p>
            </Step>
          </ol>
        </Section>

        <Section id="check-key" title="3. Check it works">
          <ul className="list-disc space-y-2 pl-5 text-base text-ink/80">
            <li>
              After saving you&apos;ll see <strong>Key saved in this browser.</strong> and a <strong>Saved key</strong> showing
              only the first and last 4 characters.
            </li>
            <li>
              Make a plan from the <Link href="/start" className={link}>app</Link>. A short test walkthrough of one small room
              is enough. When it finishes, your key works.
            </li>
            <li>
              If you see <strong>&ldquo;Meta didn&apos;t accept your API key&rdquo;</strong>, the key was mistyped, deleted, or
              your Meta account needs attention. Make a new key, then replace it below.
            </li>
            <li>
              You can see your use and spend in Meta&apos;s dashboard. Meta&apos;s <Ext href={META_QUICKSTART}>quickstart</Ext>{" "}
              lists common key errors.
            </li>
          </ul>
        </Section>

        <Section id="change-key" title="4. Remove or replace it">
          <ul className="list-disc space-y-2 pl-5 text-base text-ink/80">
            <li>
              In <Link href="/settings" className={link}>Settings</Link>, press <strong>Forget key</strong>. The key is removed
              from this browser right away.
            </li>
            <li>To use a different key, forget the old one, then paste the new one and press <strong>Save key</strong>.</li>
            <li>
              To shut a key off everywhere, delete it in Meta&apos;s dashboard (Meta&apos;s steps:{" "}
              <Ext href={`${META_AUTH}#revoke-an-api-key`}>Revoke an API key</Ext>).
            </li>
          </ul>
        </Section>

        <Section id="safe-key" title="5. Keep it safe">
          <ul className="list-disc space-y-2 pl-5 text-base text-ink/80">
            <li>Your key stays in this browser on this device. It is never sent to SightWork&apos;s servers.</li>
            <li>Your browser sends it straight to Meta, and only while it makes a plan.</li>
            <li>Treat it like a password. Don&apos;t text, email or post it, and don&apos;t share it with anyone.</li>
            <li>On a shared or church office computer, press Forget key when you&apos;re done.</li>
            <li>Make a separate key just for SightWork, so you can delete it without breaking anything else.</li>
            <li>If you think someone else has it, delete it in Meta&apos;s dashboard and make a new one.</li>
          </ul>
        </Section>

        <Section id="tips" title="Tips for a good plan">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="rounded-2xl bg-white p-4 ring-1 ring-ink/10 sm:p-6">
              <h3 className="text-lg font-extrabold">Filming the walkthrough</h3>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-base text-ink/80">
                <li>Turn the lights on and walk slowly.</li>
                <li>Hold the phone steady at chest height.</li>
                <li>Pause a second on each problem, close enough to see it.</li>
                <li>Pick the room size first so the recorder tells you when to wrap up.</li>
              </ul>
            </div>
            <div className="rounded-2xl bg-white p-4 ring-1 ring-ink/10 sm:p-6">
              <h3 className="text-lg font-extrabold">Describing the room</h3>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-base text-ink/80">
                <li>Talk while you film: say what you see and what you want fixed.</li>
                <li>Name the room and what it&apos;s used for.</li>
                <li>Say what matters most, any deadline and a rough budget.</li>
              </ul>
            </div>
            <div className="rounded-2xl bg-white p-4 ring-1 ring-ink/10 sm:p-6">
              <h3 className="text-lg font-extrabold">Churches, schools and facilities</h3>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-base text-ink/80">
                <li>Film one space per plan: a stage, a classroom, a hallway.</li>
                <li>Point out safety issues out loud, like loose cords or broken steps.</li>
                <li>Mention who will do the work: volunteers or a contractor.</li>
              </ul>
            </div>
            <div className="rounded-2xl bg-white p-4 ring-1 ring-ink/10 sm:p-6">
              <h3 className="text-lg font-extrabold">Homeowners</h3>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-base text-ink/80">
                <li>Film the room as it is now, even if it&apos;s empty.</li>
                <li>Describe the finished room you want: style, colors, what stays.</li>
                <li>Say if you plan to do it yourself or hire help.</li>
              </ul>
            </div>
          </div>
        </Section>

        <Section id="cost" title="What it costs">
          <ul className="list-disc space-y-2 pl-5 text-base text-ink/80">
            <li>
              A rough estimate: about <strong>$1 per finished plan</strong> in Meta use. Most of that is the step that finds and
              counts things in each frame. Bigger rooms and longer videos can cost a bit more.
            </li>
            <li>A plan that fails or that you stop partway can still use some credit.</li>
            <li>
              Meta sets the prices and can change them. See <Ext href={META_PRICING}>Meta Model API pricing</Ext>.
            </li>
          </ul>
        </Section>

        <div className="mt-12 flex flex-col gap-3 sm:flex-row">
          <Link href="/settings" className="btn-primary text-center">
            Add your key in Settings
          </Link>
          <Link href="/start" className="btn-secondary text-center">
            Back to the app
          </Link>
        </div>
      </main>
    </>
  );
}
