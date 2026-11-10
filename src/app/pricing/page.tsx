import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PricingPlans } from "@/components/PricingPlans";
import { billingEnabled } from "@/lib/billing/accessCode";

export const metadata: Metadata = {
  title: "Pricing | SightWork",
  description:
    "Buy SightWork plans without bringing your own key: single plans, a 5-plan pack, or a monthly or yearly subscription.",
  robots: { index: false },
};

// The billing flag is read on the server at request time.
export const dynamic = "force-dynamic";

const link =
  "underline underline-offset-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

/** Pricing: paid plans through Stripe Checkout. Hidden (404) until SIGHTWORK_BILLING is "on". */
export default function Pricing() {
  if (!billingEnabled()) notFound();
  return (
    <>
      <header className="border-b border-ink/10 pt-[env(safe-area-inset-top)]">
        <div className="mx-auto flex min-h-14 w-full max-w-5xl items-center justify-between gap-3 px-4 sm:px-6">
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
      <main
        id="main-content"
        tabIndex={-1}
        className="outline-none mx-auto w-full max-w-5xl px-4 pb-16 pt-10 sm:px-6"
      >
        <h1 className="text-3xl font-extrabold tracking-tight">Pricing</h1>
        <p className="mt-2 max-w-2xl text-base text-ink/75">
          No account and no API key needed. Pay securely with Stripe and you get
          an access code for making plans.
        </p>
        <PricingPlans />
        <p className="mt-8 text-sm text-ink/75">
          Prefer to pay the model provider yourself?{" "}
          <Link href="/settings" className={link}>
            Use SightWork free with your own Meta API key
          </Link>
          .
        </p>
      </main>
    </>
  );
}
