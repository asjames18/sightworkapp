import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Page not found | SightWork",
};

/** 404 for any unknown URL: same header as the landing, a plain message and the two ways back in. */
export default function NotFound() {
  return (
    <>
      <header className="border-b border-ink/10 pt-[env(safe-area-inset-top)]">
        <div className="mx-auto flex min-h-14 w-full max-w-5xl items-center px-4 sm:px-6">
          <Link
            href="/"
            className="-mx-2 flex min-h-11 items-center rounded-lg px-2 text-xl font-extrabold tracking-tight focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            Sight<span className="text-accent">Work</span>
          </Link>
        </div>
      </header>
      <main id="main-content" tabIndex={-1} className="outline-none mx-auto w-full max-w-xl px-4 pb-16 pt-12 sm:px-6 md:pt-16">
        <p className="text-sm font-semibold uppercase tracking-wide text-accent-dark">404</p>
        <h1 className="mt-2 text-3xl font-extrabold tracking-tight">We couldn&apos;t find that page.</h1>
        <p className="mt-3 text-base text-ink/75">The link may be old or mistyped. You can start a walkthrough or look at an example plan.</p>
        <div className="mt-8 flex flex-col gap-3 sm:flex-row">
          <Link href="/start" className="btn-primary">
            Film a walkthrough
          </Link>
          <Link href="/start?view=example" className="btn-secondary">
            See an example plan
          </Link>
        </div>
      </main>
    </>
  );
}
