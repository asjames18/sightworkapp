"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";

/**
 * Shown when a page throws while it is running: a plain message, a way to try again and the two ways back in,
 * so a script error never leaves a bare browser error page. Plans and videos saved on this device are not touched.
 * The page header is drawn here too, because a failure in the root layout replaces it.
 */
export function ErrorPanel({ onRetry }: { onRetry: () => void }) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    // Screen readers and keyboard users land on the message instead of an empty page.
    heading.current?.focus();
  }, []);
  return (
    <>
      <header className="border-b border-ink/10 pt-[env(safe-area-inset-top)] print:hidden">
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
        <div role="alert" data-testid="error-panel">
          <p className="text-sm font-semibold uppercase tracking-wide text-accent-dark">Something went wrong</p>
          <h1 ref={heading} tabIndex={-1} className="mt-2 text-3xl font-extrabold tracking-tight outline-none">
            This page hit a problem.
          </h1>
          <p className="mt-3 text-base text-ink/75">
            Nothing you saved was lost: plans and videos kept on this device are still here. Try again, or start fresh.
          </p>
        </div>
        <div className="mt-8 flex flex-col gap-3 sm:flex-row">
          <button type="button" onClick={onRetry} className="btn-primary" data-testid="error-retry">
            Try again
          </button>
          <Link href="/start" className="btn-secondary">
            Back to the start
          </Link>
          <Link href="/start?view=example" className="btn-secondary">
            See an example plan
          </Link>
        </div>
      </main>
    </>
  );
}
