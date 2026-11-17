"use client";

import { useState } from "react";
import type { UsageRow } from "@/lib/usage/store";
import { summarize } from "@/lib/usage/summary";

const field =
  "mt-1 block min-h-11 w-full rounded-xl border border-ink/30 bg-white px-3 text-base focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

const MODE: Record<string, string> = { byok: "Own Meta API key", code: "Access code" };

function Table({ caption, head, rows, testId }: { caption: string; head: string[]; rows: (string | number)[][]; testId: string }) {
  return (
    <table className="mt-6 w-full border-collapse text-left text-sm" data-testid={testId}>
      <caption className="mb-2 text-left text-lg font-bold">{caption}</caption>
      <thead>
        <tr>
          {head.map((h) => (
            <th key={h} scope="col" className="border-b border-ink/20 py-2 pr-3 font-semibold">
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 ? (
          <tr>
            <td colSpan={head.length} className="py-2 text-ink/70">
              Nothing counted yet.
            </td>
          </tr>
        ) : (
          rows.map((r, i) => (
            <tr key={i}>
              {r.map((c, j) => (
                <td key={j} className="border-b border-ink/10 py-2 pr-3 tabular-nums">
                  {c}
                </td>
              ))}
            </tr>
          ))
        )}
      </tbody>
    </table>
  );
}

/** Asks for the view key (kept in memory only, never in the address or a cookie), then shows the totals. */
export function UsageReport() {
  const [key, setKey] = useState("");
  const [days, setDays] = useState(30);
  const [site, setSite] = useState<"production" | "preview">("production");
  const [rows, setRows] = useState<UsageRow[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function load(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/usage/report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: key.trim(), days }),
      });
      const j = (await res.json().catch(() => ({}))) as { rows?: UsageRow[]; error?: string };
      if (res.ok && Array.isArray(j.rows)) setRows(j.rows);
      else setError(j.error ?? "The counts can't be read right now.");
    } catch {
      setError("You seem to be offline. Check your connection and try again.");
    }
    setBusy(false);
  }

  const s = rows ? summarize(rows, site) : null;
  return (
    <>
      <form onSubmit={load} className="mt-6 grid gap-4 sm:grid-cols-[1fr_auto_auto] sm:items-end" data-testid="usage-form">
        <label className="block text-sm font-semibold">
          View key
          <input type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} className={field} required />
        </label>
        <label className="block text-sm font-semibold">
          Days
          <select value={days} onChange={(e) => setDays(Number(e.target.value))} className={field}>
            {[7, 30, 90, 400].map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className="btn-primary" disabled={busy}>
          {busy ? "Loading…" : "Show counts"}
        </button>
      </form>
      {error && (
        <p role="alert" className="mt-4 text-base font-semibold text-red-800" data-testid="usage-error">
          {error}
        </p>
      )}
      {s && (
        <section aria-label="Counts" data-testid="usage-counts">
          <fieldset className="mt-6 flex gap-4 text-sm">
            <legend className="sr-only">Which site</legend>
            {(["production", "preview"] as const).map((v) => (
              <label key={v} className="flex min-h-11 items-center gap-2">
                <input type="radio" name="site" checked={site === v} onChange={() => setSite(v)} />
                {v === "production" ? "Live site" : "Test builds"}
              </label>
            ))}
          </fieldset>
          <dl className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[
              ["Page views", s.views],
              ["Plans started", s.plans.reduce((n, p) => n + p.started, 0)],
              ["Checkouts finished", s.checkoutsDone],
              ["Code recoveries", s.recoverUsed],
            ].map(([label, n]) => (
              <div key={label} className="rounded-xl border border-ink/15 bg-white p-3">
                <dt className="text-sm text-ink/70">{label}</dt>
                <dd className="text-2xl font-extrabold tabular-nums">{n}</dd>
              </div>
            ))}
          </dl>
          <Table
            testId="usage-plans"
            caption="Plan runs"
            head={["How it ran", "Started", "Finished", "Failed"]}
            rows={s.plans.map((p) => [MODE[p.mode] ?? p.mode, p.started, p.done, p.failed])}
          />
          <Table testId="usage-pages" caption="Page views by page" head={["Page", "Views"]} rows={s.pages.map((p) => [p.page, p.count])} />
          <Table testId="usage-devices" caption="Page views by device" head={["Device", "Views"]} rows={s.devices.map((d) => [d.device, d.count])} />
          <Table
            testId="usage-checkouts"
            caption={`Checkouts opened (${s.checkoutsStarted})`}
            head={["Plan", "Opened"]}
            rows={s.checkoutsByPlan.map((c) => [c.plan, c.count])}
          />
          <Table
            testId="usage-days"
            caption="By day (Eastern time)"
            head={["Day", "Views", "Plans started", "Plans finished", "Checkouts finished"]}
            rows={s.byDay.map((d) => [d.day, d.views, d.plansStarted, d.plansDone, d.checkoutsDone])}
          />
        </section>
      )}
    </>
  );
}
