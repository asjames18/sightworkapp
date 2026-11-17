import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { UsageReport } from "@/components/UsageReport";
import { usageStore } from "@/lib/usage/store";

export const metadata: Metadata = {
  title: "Usage | SightWork",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export const dynamic = "force-dynamic";

/** The owner's view of the anonymous usage counts. Hidden (404) until the counts and a view key are set up. */
export default function UsagePage() {
  if (!usageStore(process.env) || (process.env.SIGHTWORK_USAGE_VIEW_TOKEN?.trim().length ?? 0) < 32) notFound();
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
        </div>
      </header>
      <main id="main-content" tabIndex={-1} className="outline-none mx-auto w-full max-w-3xl px-4 pb-16 pt-10 sm:px-6">
        <h1 className="text-3xl font-extrabold tracking-tight">Usage</h1>
        <p className="mt-3 text-base text-ink/80">
          Anonymous daily totals only: page views, plan runs, checkouts and code recoveries. No names, emails, IP
          addresses, codes, keys, videos or plans are kept, and no cookies are used.
        </p>
        <UsageReport />
      </main>
    </>
  );
}
