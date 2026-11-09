import type { Metadata } from "next";
import Link from "next/link";
import { siteStatus, type StatusLevel } from "@/lib/status";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Status | SightWork",
  description: "Is SightWork up, which Meta models are configured, and the safeguards that are always on.",
};

const DOT: Record<StatusLevel, string> = { ok: "bg-safe", off: "bg-ink/30", warn: "bg-amber-500" };
const WORD: Record<StatusLevel, string> = { ok: "OK", off: "Off", warn: "Check" };

/** Public status page: presence-only config checks, no secrets, no model calls (src/lib/status.ts). */
export default function StatusPage() {
  const s = siteStatus(process.env);
  const allOk = s.rows.every((r) => r.level === "ok");
  return (
    <>
      <header className="border-b border-ink/10 pt-[env(safe-area-inset-top)]">
        <div className="mx-auto flex min-h-14 w-full max-w-3xl items-center justify-between gap-3 px-4 sm:px-6">
          <Link href="/" className="-mx-2 flex min-h-11 items-center rounded-lg px-2 text-xl font-extrabold tracking-tight focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
            Sight<span className="text-accent">Work</span>
          </Link>
          <Link href="/start" className="btn-secondary text-sm">
            Open the app
          </Link>
        </div>
      </header>
      <main id="main-content" tabIndex={-1} className="outline-none mx-auto w-full max-w-3xl px-4 pb-16 pt-10 sm:px-6">
        <h1 className="text-3xl font-extrabold tracking-tight">Status</h1>
        <p className="mt-3 flex items-center gap-2 text-lg font-semibold" data-testid="status-summary">
          <span aria-hidden="true" className={`h-3 w-3 rounded-full ${allOk ? "bg-safe" : "bg-amber-500"}`} />
          {allOk ? "All systems ready" : "Up, with notes below"}
        </p>
        <p className="mt-1 text-sm text-ink/70">
          Build {s.commit ?? "local"} · {s.environment} · checked when this page loaded. This page makes no model calls.
        </p>

        <ul className="mt-8 divide-y divide-ink/10 rounded-2xl border border-ink/10 bg-white">
          {s.rows.map((r) => (
            <li key={r.name} className="flex items-start gap-3 p-4">
              <span aria-hidden="true" className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${DOT[r.level]}`} />
              <div className="min-w-0 flex-1">
                <p className="font-semibold">{r.name}</p>
                <p className="text-sm text-ink/70">{r.detail}</p>
              </div>
              <span className="text-sm font-semibold text-ink/70">{WORD[r.level]}</span>
            </li>
          ))}
        </ul>

        <section aria-labelledby="safe-heading" className="mt-10">
          <h2 id="safe-heading" className="text-xl font-extrabold">Always on</h2>
          <ul className="mt-4 grid list-disc gap-2 pl-5 text-base leading-relaxed text-ink/75 marker:text-ink/40">
            {s.safeguards.map((g) => (
              <li key={g}>{g}</li>
            ))}
          </ul>
        </section>
      </main>
    </>
  );
}
