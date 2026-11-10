"use client";

import { useState } from "react";

type Note = { kind: "ok" | "err"; text: string } | null;

const field =
  "mt-1 block min-h-11 w-full rounded-xl border border-ink/30 bg-white px-3 text-base focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

async function post(url: string, body: unknown) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = (await res.json().catch(() => ({}))) as {
    url?: string;
    message?: string;
    error?: string;
  };
  return { ok: res.ok, j };
}

/** Manage a subscription, or find a past purchase by email. */
export function PricingAccount() {
  const [code, setCode] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState<"portal" | "recover" | null>(null);
  const [portalNote, setPortalNote] = useState<Note>(null);
  const [recoverNote, setRecoverNote] = useState<Note>(null);
  const offline =
    "You seem to be offline. Check your connection and try again.";

  async function openPortal(e: React.FormEvent) {
    e.preventDefault();
    setBusy("portal");
    setPortalNote(null);
    try {
      const { ok, j } = await post("/api/billing/portal", {
        code: code.trim(),
      });
      if (
        ok &&
        typeof j.url === "string" &&
        j.url.startsWith("https://billing.stripe.com/")
      ) {
        window.location.assign(j.url);
        return;
      }
      setPortalNote({
        kind: "err",
        text: j.error ?? "Billing settings aren't available right now.",
      });
    } catch {
      setPortalNote({ kind: "err", text: offline });
    }
    setBusy(null);
  }

  async function findPurchase(e: React.FormEvent) {
    e.preventDefault();
    setBusy("recover");
    setRecoverNote(null);
    try {
      const { ok, j } = await post("/api/billing/recover", {
        email: email.trim(),
      });
      setRecoverNote(
        ok && j.message
          ? { kind: "ok", text: j.message }
          : {
              kind: "err",
              text: j.error ?? "We can't look that up right now.",
            },
      );
    } catch {
      setRecoverNote({ kind: "err", text: offline });
    }
    setBusy(null);
  }

  const box = "rounded-2xl border border-ink/15 bg-white p-5 shadow-sm";
  const noteCls = (n: Note) =>
    `mt-3 min-h-6 text-sm font-semibold ${n?.kind === "ok" ? "text-green-800" : "text-red-700"}`;
  return (
    <div
      className="mt-12 grid gap-4 md:grid-cols-2"
      data-testid="pricing-account"
    >
      <form className={box} onSubmit={openPortal} aria-labelledby="portal-h">
        <h2 id="portal-h" className="text-lg font-bold">
          Manage a subscription
        </h2>
        <p className="mt-1 text-sm text-ink/75">
          Enter your access code to update your card, switch plans or cancel.
        </p>
        <label
          htmlFor="portal-code"
          className="mt-4 block text-sm font-semibold"
        >
          Access code
        </label>
        <input
          id="portal-code"
          className={field}
          value={code}
          onChange={(e) => setCode(e.target.value)}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          required
        />
        <button
          type="submit"
          className="btn-secondary mt-4"
          disabled={busy !== null || !code.trim()}
          data-testid="portal-go"
        >
          {busy === "portal" ? "Opening…" : "Open billing settings"}
        </button>
        <p
          role="status"
          className={noteCls(portalNote)}
          data-testid="portal-note"
        >
          {portalNote?.text ?? ""}
        </p>
      </form>
      <form className={box} onSubmit={findPurchase} aria-labelledby="recover-h">
        <h2 id="recover-h" className="text-lg font-bold">
          Lost your access code?
        </h2>
        <p className="mt-1 text-sm text-ink/75">
          Enter the email you paid with and we will send your code again.
        </p>
        <label
          htmlFor="recover-email"
          className="mt-4 block text-sm font-semibold"
        >
          Email
        </label>
        <input
          id="recover-email"
          type="email"
          className={field}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="email"
          required
        />
        <button
          type="submit"
          className="btn-secondary mt-4"
          disabled={busy !== null || !email.trim()}
          data-testid="recover-go"
        >
          {busy === "recover" ? "Looking…" : "Email me my code"}
        </button>
        <p
          role="status"
          className={noteCls(recoverNote)}
          data-testid="recover-note"
        >
          {recoverNote?.text ?? ""}
        </p>
      </form>
    </div>
  );
}
