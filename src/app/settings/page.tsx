import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ByokKeyForm } from "@/components/ByokKeyForm";
import { byokEnabled } from "@/lib/client/byokKey";

export const metadata: Metadata = {
  title: "Settings | SightWork",
  description: "Use SightWork free with your own Meta API key, kept only in your browser.",
  robots: { index: false },
};

const link = "underline underline-offset-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

/** Settings: bring your own Meta API key. Hidden (404) until NEXT_PUBLIC_SIGHTWORK_BYOK is "on". */
export default function Settings() {
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
          <Link href="/start" className="btn-secondary text-sm">
            Back to the app
          </Link>
        </div>
      </header>
      <main id="main-content" tabIndex={-1} className="outline-none mx-auto w-full max-w-3xl px-4 pb-16 pt-10 sm:px-6">
        <h1 className="text-3xl font-extrabold tracking-tight">Settings</h1>

        <section aria-labelledby="byok-heading" className="mt-8">
          <h2 id="byok-heading" className="text-xl font-extrabold">
            Use your own Meta API key
          </h2>
          <p className="mt-2 text-base text-ink/75">
            SightWork is free with your own key. You pay Meta directly for your runs, usually about $0.40 to $1.20 a plan.
          </p>
          <p className="mt-3 text-base">
            <Link href="/help/own-key" className={`${link} font-semibold text-accent-dark`} data-testid="own-key-guide-link">
              New to this? Read the step-by-step guide
            </Link>
          </p>
          <ul className="mt-4 list-disc space-y-1 pl-5 text-sm text-ink/75">
            <li>Your key is saved only in this browser on this device.</li>
            <li>It is never sent to SightWork&apos;s servers. Your browser sends it straight to Meta, and only when you make a plan.</li>
            <li>Anyone who can use this browser profile can use the key, so forget it on shared computers.</li>
            <li>You can remove it here any time, or revoke it in Meta&apos;s dashboard.</li>
          </ul>
          <div className="mt-6">
            <ByokKeyForm />
          </div>
          <p className="mt-4 text-sm text-ink/75">
            Prices are Meta&apos;s:{" "}
            <a href="https://dev.meta.ai/docs/pricing-rate-limits" className={link} target="_blank" rel="noopener noreferrer">
              Meta Model API pricing
            </a>
            .
          </p>
        </section>
      </main>
    </>
  );
}
