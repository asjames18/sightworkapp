"use client";

import { useState } from "react";
import { normalizeEmail } from "@/lib/billing/email";

type Billing = "monthly" | "yearly";

const PACKS = [
  {
    key: "single",
    name: "Single Plan",
    price: "$9",
    note: "One plan, paid once.",
  },
  {
    key: "pack5",
    name: "5-Plan Pack",
    price: "$29",
    note: "Five plans, paid once. Use them any time.",
  },
] as const;

const SUBS = [
  {
    base: "church",
    name: "Church & Small Facility",
    monthly: "$19",
    yearly: "$190",
  },
  {
    base: "ministry",
    name: "Ministry & School",
    monthly: "$49",
    yearly: "$490",
  },
  { base: "multisite", name: "Multi-site", monthly: "$129", yearly: "$1,290" },
] as const;

/**
 * Plan cards that send the buyer to Stripe's hosted Checkout. The buyer's email is required first:
 * the buy buttons stay disabled until it is valid, so Stripe's page (with its Apple Pay, Google Pay
 * and Link buttons) only opens with an email we can send the access code to.
 */
export function PricingPlans() {
  const [billing, setBilling] = useState<Billing>("monthly");
  const [email, setEmail] = useState("");
  const [emailTouched, setEmailTouched] = useState(false);
  const emailOk = normalizeEmail(email) !== null;
  const showEmailError = emailTouched && !emailOk;
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function buy(plan: string) {
    if (!emailOk) {
      setEmailTouched(true);
      return;
    }
    setBusy(plan);
    setError(null);
    try {
      const res = await fetch("/api/billing/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan, email: email.trim() }),
      });
      const j = (await res.json().catch(() => ({}))) as {
        url?: string;
        error?: string;
      };
      if (
        res.ok &&
        typeof j.url === "string" &&
        j.url.startsWith("https://checkout.stripe.com/")
      ) {
        window.location.assign(j.url);
        return;
      }
      setError(
        j.error ??
          "Checkout isn't available right now. Please try again in a few minutes.",
      );
    } catch {
      setError("You seem to be offline. Check your connection and try again.");
    }
    setBusy(null);
  }

  const card =
    "flex flex-col rounded-2xl border border-ink/15 bg-white p-5 shadow-sm";
  return (
    <div className="mt-8">
      <div className="max-w-md rounded-2xl border border-ink/15 bg-white p-5 shadow-sm">
        <label htmlFor="checkout-email" className="block text-sm font-semibold">
          Email (required)
        </label>
        <p id="checkout-email-hint" className="mt-1 text-sm text-ink/75">
          We send your access code here, and can send it again if you lose it.
          Enter it before you pay, whether by card or Apple Pay.
        </p>
        <input
          id="checkout-email"
          type="email"
          inputMode="email"
          autoComplete="email"
          required
          aria-required="true"
          aria-invalid={showEmailError}
          aria-describedby={
            showEmailError
              ? "checkout-email-hint checkout-email-error"
              : "checkout-email-hint"
          }
          className="mt-2 block min-h-11 w-full rounded-xl border border-ink/30 bg-white px-3 text-base focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          onBlur={() => setEmailTouched(true)}
          data-testid="checkout-email"
        />
        <p
          id="checkout-email-error"
          className="mt-1 min-h-5 text-sm font-semibold text-red-700"
          data-testid="checkout-email-error"
        >
          {showEmailError ? "Enter a valid email address, like name@example.com." : ""}
        </p>
      </div>

      <h2 className="mt-8 text-xl font-extrabold">Pay as you go</h2>
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        {PACKS.map((p) => (
          <section
            key={p.key}
            className={card}
            aria-labelledby={`plan-${p.key}`}
          >
            <h3 id={`plan-${p.key}`} className="text-lg font-bold">
              {p.name}
            </h3>
            <p className="mt-1 text-3xl font-extrabold">{p.price}</p>
            <p className="mt-2 flex-1 text-sm text-ink/75">{p.note}</p>
            <button
              type="button"
              className="btn-primary mt-4"
              onClick={() => buy(p.key)}
              disabled={busy !== null || !emailOk}
              data-testid={`buy-${p.key}`}
            >
              {busy === p.key ? "Opening checkout…" : `Buy ${p.name}`}
            </button>
          </section>
        ))}
      </div>

      <div className="mt-10 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-xl font-extrabold">Subscriptions</h2>
        <div
          role="group"
          aria-label="Billing period"
          className="inline-flex rounded-xl border border-ink/20 p-1"
        >
          {(["monthly", "yearly"] as const).map((b) => (
            <button
              key={b}
              type="button"
              aria-pressed={billing === b}
              onClick={() => setBilling(b)}
              className={`min-h-11 rounded-lg px-4 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
                billing === b ? "bg-ink text-white" : "text-ink"
              }`}
              data-testid={`period-${b}`}
            >
              {b === "monthly" ? "Monthly" : "Yearly (2 months free)"}
            </button>
          ))}
        </div>
      </div>
      <p className="mt-2 text-sm text-ink/75">
        {billing === "yearly"
          ? "Verified nonprofits can enter the code NONPROFIT25 at checkout for 25% off yearly plans."
          : "Cancel any time from the billing portal. Nonprofit discounts apply to yearly plans."}
      </p>
      <div className="mt-4 grid gap-4 md:grid-cols-3">
        {SUBS.map((s) => {
          const key = `${s.base}-${billing}`;
          return (
            <section
              key={s.base}
              className={card}
              aria-labelledby={`plan-${s.base}`}
            >
              <h3 id={`plan-${s.base}`} className="text-lg font-bold">
                {s.name}
              </h3>
              <p className="mt-1 text-3xl font-extrabold">
                {billing === "monthly" ? s.monthly : s.yearly}
                <span className="text-base font-semibold text-ink/75">
                  {billing === "monthly" ? " / month" : " / year"}
                </span>
              </p>
              <div className="flex-1" />
              <button
                type="button"
                className="btn-primary mt-4"
                onClick={() => buy(key)}
                disabled={busy !== null || !emailOk}
                data-testid={`buy-${s.base}`}
              >
                {busy === key ? "Opening checkout…" : `Subscribe`}
              </button>
            </section>
          );
        })}
      </div>
      <p
        role="alert"
        aria-live="assertive"
        className="mt-4 min-h-6 text-sm font-semibold text-red-700"
        data-testid="checkout-error"
      >
        {error ?? ""}
      </p>
    </div>
  );
}
