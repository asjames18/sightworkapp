import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { BillingDone } from "@/components/BillingDone";
import { billingEnabled } from "@/lib/billing/accessCode";

export const metadata: Metadata = {
  title: "Your purchase | SightWork",
  robots: { index: false },
  referrer: "no-referrer",
};

export const dynamic = "force-dynamic";

/** Where Stripe sends buyers after paying. Hidden (404) until SIGHTWORK_BILLING is "on". */
export default function BillingDonePage() {
  if (!billingEnabled()) notFound();
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
        <h1 className="text-3xl font-extrabold tracking-tight">Your purchase</h1>
        <BillingDone />
      </main>
    </>
  );
}
