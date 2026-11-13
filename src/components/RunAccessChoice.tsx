"use client";

import { useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { checkKey, saveKey } from "@/lib/client/byokKey";
import { loadAccessCode } from "@/lib/client/accessCode";
import { OWN_KEY_GUIDE_HREF, runOptions, SETTINGS_HREF } from "@/lib/client/runAccess";

const link = "font-semibold underline underline-offset-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

/**
 * The run choice: shown before filming (where="start") and on the video card (where="video") when "Make my
 * work plan" is pressed with no key, access code or tester code saved. Nothing is sent until one is chosen. The video stays on this card:
 * - "Use your own key (free)": paste the key right here (kept in this browser), and the plan starts on it;
 * - "Buy plans": the pricing page opens in a new tab; the access code from checkout goes in the field below
 *   (the return page also saves it in this browser).
 * `codeField` is the access-code form, which starts the run once a code is saved.
 */
export function RunAccessChoice({
  onKeySaved,
  onStoredCode,
  codeField,
  where = "video",
}: {
  onKeySaved: () => void;
  /** An access code was saved in this browser meanwhile (checkout finished in the other tab): run with it. */
  onStoredCode: () => void;
  codeField: React.ReactNode;
  /** "start": shown before filming, in place of the record and upload buttons. "video": on the video card. */
  where?: "start" | "video";
}) {
  const options = runOptions();
  const own = options.find((o) => o.key === "own-key");
  const buy = options.find((o) => o.key === "buy");
  const id = useId();
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const heading = useRef<HTMLHeadingElement>(null);
  // On the video card the choice opens after a button press, so focus moves to it; before filming it is
  // simply the page, so focus stays where the visitor is.
  useEffect(() => {
    if (where === "video") heading.current?.focus();
  }, [where]);
  // The return page after checkout (in the tab Pricing opened) saves the access code in this browser.
  // Offer it here as soon as it shows up, so the buyer doesn't have to copy it across.
  const [storedCode, setStoredCode] = useState(false);
  useEffect(() => {
    const look = () => setStoredCode(loadAccessCode() !== "");
    look();
    window.addEventListener("storage", look);
    window.addEventListener("focus", look);
    return () => {
      window.removeEventListener("storage", look);
      window.removeEventListener("focus", look);
    };
  }, []);
  return (
    <div
      role="region"
      aria-labelledby={`${id}-h`}
      data-testid={where === "start" ? "start-gate" : "run-choice"}
      className={`${where === "start" ? "mt-6 p-4 sm:p-5" : "mt-3 p-3"} rounded-xl bg-amber-50 text-amber-950`}
    >
      <h2 id={`${id}-h`} ref={heading} tabIndex={-1} className={`${where === "start" ? "text-xl" : "text-base"} font-extrabold outline-none`}>
        {where === "start" ? "Before you film: pick how to make your plan" : "How do you want to make this plan?"}
      </h2>
      <p className="mt-0.5 text-sm">
        {where === "start"
          ? "Plans from your own video need your own key or a paid plan. Example plans below stay free to open."
          : "Your video is kept here. Nothing is sent until you pick one."}
      </p>

      {own && (
        <form
          className="mt-3 rounded-lg bg-white p-3"
          data-testid="run-choice-own-key"
          onSubmit={(e) => {
            e.preventDefault();
            const c = checkKey(draft);
            if (!c.ok) return setError(c.reason);
            if (!saveKey(c.key)) return setError("This browser wouldn't keep the key. Private browsing or strict settings can block it.");
            setDraft("");
            setError("");
            onKeySaved();
          }}
        >
          <p className="font-semibold">{own.label}</p>
          <p className="mt-0.5 text-sm text-ink/75">{own.detail}</p>
          <label htmlFor={`${id}-key`} className="mt-2 block text-sm font-semibold">
            Your Meta API key
          </label>
          <div className="mt-1 flex gap-2">
            <input
              id={`${id}-key`}
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={draft}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? `${id}-key-error` : undefined}
              onChange={(e) => {
                setDraft(e.target.value);
                setError("");
              }}
              className="min-h-11 min-w-0 flex-1 rounded-lg border border-ink/20 bg-white px-3 text-base"
            />
            <button type="submit" className="btn-primary shrink-0 text-sm">
              {where === "start" ? "Save key" : "Save key and make my plan"}
            </button>
          </div>
          {error && (
            <p id={`${id}-key-error`} role="alert" className="mt-1 text-sm text-red-800">
              {error}
            </p>
          )}
          <p className="mt-1 text-xs text-ink/70">
            <Link href={OWN_KEY_GUIDE_HREF} target="_blank" rel="noopener" className={link}>
              How to get a key
            </Link>{" "}
            · Change or forget it any time in{" "}
            <Link href={SETTINGS_HREF} target="_blank" rel="noopener" className={link}>
              Settings
            </Link>
            .
          </p>
        </form>
      )}

      {buy && (
        <div className="mt-3 rounded-lg bg-white p-3" data-testid="run-choice-buy">
          <p className="font-semibold">{buy.label}</p>
          <p className="mt-0.5 text-sm text-ink/75">{buy.detail}</p>
          <Link href={buy.href} target="_blank" rel="noopener" className="btn-secondary mt-2 inline-flex text-sm" data-testid="run-choice-pricing">
            See plans and prices (opens a new tab)
          </Link>
          {storedCode && (
            <button type="button" onClick={onStoredCode} className="btn-primary mt-3 w-full text-sm" data-testid="run-choice-stored-code">
              {where === "start" ? "Use the code from your purchase" : "Make my plan with the code from your purchase"}
            </button>
          )}
          <p className="mt-3 text-sm font-semibold">Already have an access code?</p>
          {codeField}
        </div>
      )}

      {!buy && codeField}
    </div>
  );
}
