"use client";

import { useEffect, useId, useState } from "react";
import { checkKey, forgetKey, loadKey, maskKey, saveKey } from "@/lib/client/byokKey";

/**
 * Paste, save and forget the user's own Meta API key. The key lives only in this browser (byokKey.ts).
 * After saving, the screen shows the masked key only; the field is cleared so the full key isn't left on screen.
 */
export function ByokKeyForm() {
  const id = useId();
  const [ready, setReady] = useState(false);
  const [saved, setSaved] = useState("");
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");

  useEffect(() => {
    setSaved(loadKey());
    setReady(true);
  }, []);

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const c = checkKey(draft);
    if (!c.ok) {
      setError(c.reason);
      setStatus("");
      return;
    }
    if (!saveKey(c.key)) {
      setError("This browser wouldn't keep the key. Private browsing or strict settings can block it.");
      setStatus("");
      return;
    }
    setSaved(c.key);
    setDraft("");
    setError("");
    setStatus("Key saved in this browser.");
  }

  function onForget() {
    forgetKey();
    setSaved("");
    setDraft("");
    setError("");
    setStatus("Key forgotten. Nothing is saved in this browser now.");
  }

  return (
    <div className="rounded-2xl bg-white p-4 ring-1 ring-ink/10 sm:p-6" data-testid="byok-card">
      {ready && saved ? (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <p className="text-sm text-ink/75">Saved key</p>
            <p className="mt-1 break-all font-mono text-base" data-testid="byok-masked">
              {maskKey(saved)}
            </p>
          </div>
          <button type="button" onClick={onForget} className="btn-secondary shrink-0 text-sm" data-testid="byok-forget">
            Forget key
          </button>
        </div>
      ) : (
        <form onSubmit={onSubmit} noValidate className="flex flex-col gap-3">
          <label htmlFor={`${id}-key`} className="text-base font-semibold">
            Meta API key
          </label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              id={`${id}-key`}
              name="byok-key"
              type="password"
              autoComplete="off"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              inputMode="text"
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value);
                setError("");
              }}
              aria-invalid={error ? true : undefined}
              aria-describedby={`${id}-help${error ? ` ${id}-err` : ""}`}
              data-testid="byok-input"
              className="min-h-11 min-w-0 flex-1 rounded-lg border border-ink/30 bg-white px-3 font-mono text-base"
            />
            <button type="submit" className="btn-primary shrink-0 text-sm" disabled={!ready} data-testid="byok-save">
              Save key
            </button>
          </div>
          <p id={`${id}-help`} className="text-sm text-ink/75">
            Starts with LLM_. You can make one in the Meta developer dashboard.
          </p>
          {error ? (
            <p id={`${id}-err`} className="text-sm font-semibold text-red-800" data-testid="byok-error">
              {error}
            </p>
          ) : null}
        </form>
      )}
      <p role="status" aria-live="polite" className="mt-3 text-sm text-ink/75 empty:hidden" data-testid="byok-status">
        {status}
      </p>
    </div>
  );
}
