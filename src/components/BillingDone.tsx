"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

type State =
  | { s: "loading" }
  | { s: "ready"; code: string; plan: string }
  | { s: "pending" }
  | { s: "error"; msg: string };

/** Asks the server to check the Stripe session from the address and shows the access code. */
export function BillingDone() {
  const [st, setSt] = useState<State>({ s: "loading" });
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const sessionId = new URLSearchParams(window.location.search).get("session_id");
    if (!sessionId) {
      setSt({ s: "error", msg: "This link isn't a valid purchase link." });
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch("/api/billing/done", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId }),
        });
        const j = (await r.json()) as { code?: string; plan?: string; error?: string; pending?: boolean };
        if (cancelled) return;
        if (r.ok && j.code) setSt({ s: "ready", code: j.code, plan: j.plan ?? "" });
        else if (j.pending) setSt({ s: "pending" });
        else setSt({ s: "error", msg: j.error ?? "We can't confirm your purchase right now." });
      } catch {
        if (!cancelled) setSt({ s: "error", msg: "We can't confirm your purchase right now. Please refresh in a few minutes." });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function copy(code: string) {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div aria-live="polite" className="mt-4" data-testid="billing-done">
      {st.s === "loading" && <p className="text-base text-ink/75">Checking your payment…</p>}
      {st.s === "pending" && (
        <p className="text-base text-ink/75" data-testid="billing-pending">
          Your payment hasn&apos;t gone through yet. Refresh this page in a moment.
        </p>
      )}
      {st.s === "error" && (
        <p role="alert" className="text-base text-ink" data-testid="billing-error">
          {st.msg}{" "}
          <Link href="/pricing" className="underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
            Back to pricing
          </Link>
        </p>
      )}
      {st.s === "ready" && (
        <section aria-labelledby="code-h">
          <p className="max-w-2xl text-base text-ink/75">Thank you. {st.plan} is ready to use.</p>
          <h2 id="code-h" className="mt-6 text-lg font-bold">
            Your access code
          </h2>
          <p className="mt-1 max-w-2xl text-sm text-ink/75">
            Save it somewhere safe. Anyone with this code can use your plans, and this page is the only place it is shown.
          </p>
          <code
            data-testid="access-code"
            className="mt-3 block break-all rounded-lg border border-ink/20 bg-ink/5 p-3 text-sm"
          >
            {st.code}
          </code>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <button type="button" className="btn-primary" data-testid="copy-code" onClick={() => copy(st.code)}>
              {copied ? "Copied" : "Copy code"}
            </button>
            <Link href="/start" className="btn-secondary">
              Make a plan
            </Link>
          </div>
        </section>
      )}
    </div>
  );
}
