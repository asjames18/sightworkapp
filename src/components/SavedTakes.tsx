"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  listSavedTakes,
  listSavedTakesOnServer,
  openSavedTake,
  removeSavedTakeWithUndo,
  restoreSavedTake,
  subscribeSavedTakes,
  takeSize,
  takeWhen,
  type RemovedTake,
  type TakeEntry,
} from "@/lib/client/savedTakes";
import { formatDuration } from "@/lib/client/duration";
import { listRecentPlans, listRecentPlansOnServer, openRecentPlan, subscribeRecentPlans } from "@/lib/client/recentPlans";
import type { SavedPlan } from "@/lib/client/lastPlan";
import { planForTake, takePlanLine } from "@/lib/client/takePlan";
import { SaveVideoButton } from "./SaveVideoButton";
import { TakeThumb } from "./TakeThumb";
import { TakePreview } from "./TakePreview";
import { keepOpenTake, nextOpenTake, takeWatchLabels } from "@/lib/client/takePreview";
import { takeFit, type TakeFitTone } from "@/lib/client/takeFit";
import { bestTake } from "@/lib/client/takeBest";

const FIT_STYLE: Record<TakeFitTone, string> = {
  good: "bg-emerald-50 text-emerald-900 ring-emerald-700/30",
  short: "bg-amber-50 text-amber-900 ring-amber-700/30",
  long: "bg-amber-50 text-amber-900 ring-amber-700/30",
  block: "bg-red-50 text-red-900 ring-red-700/30",
};

/**
 * "Your saved takes": the last few walkthroughs recorded in SightWork's camera, kept on this device.
 * Each row can be saved to the phone's Photos (share sheet) or downloaded, used for a new plan, or removed.
 * Each row leads with a small still from the take's own video so back-to-back takes are easy to tell apart.
 * A take that already made a plan (still on the recent plans list) says so and can open that plan.
 * Remove offers an Undo that puts the take and its video back (until the next tap on the list), so a
 * walkthrough is never lost to one mis-tap. Watch plays a take back inline (one at a time) so it can be
 * checked before it is used. Each row also says how its length fits the room size picked on this screen
 * ("Good length for Large", "Short for Large", "Too long for Large"), using the upload check's own rules.
 * With two or more takes, the one whose length fits best is marked "Best pick for Large".
 * Hidden in print.
 */
export function SavedTakes({
  onUse,
  onOpenPlan,
  roomSize,
}: {
  onUse?: (file: File) => void;
  onOpenPlan?: (saved: SavedPlan) => void;
  roomSize?: string | null;
}) {
  const list = useSyncExternalStore(subscribeSavedTakes, listSavedTakes, listSavedTakesOnServer);
  const recents = useSyncExternalStore(subscribeRecentPlans, listRecentPlans, listRecentPlansOnServer);
  const [gone, setGone] = useState<string | null>(null);
  const [removed, setRemoved] = useState<RemovedTake | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [watching, setWatching] = useState<string | null>(null);
  const openId = keepOpenTake(watching, list.map((t) => t.id));
  const undoRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  // Keyboard and screen reader users keep their place: focus moves to Undo after a remove, and back
  // to the restored take's first button (Watch) after Undo.
  useEffect(() => {
    if (removed) undoRef.current?.focus();
  }, [removed]);
  useEffect(() => {
    if (!focusId) return;
    listRef.current?.querySelector<HTMLElement>(`[data-take-id="${CSS.escape(focusId)}"] button`)?.focus();
    setFocusId(null);
  }, [focusId, list]);

  const remove = (e: TakeEntry) => {
    setGone(null);
    setRemoved(null);
    void removeSavedTakeWithUndo(e.id).then(setRemoved);
  };

  const undo = () => {
    const r = removed;
    setRemoved(null);
    if (!r) return;
    void restoreSavedTake(r).then((ok) => {
      if (ok) setFocusId(r.entry.id);
      else setGone("That take couldn't be put back on this device.");
    });
  };

  const undoRow = removed && (
    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1" data-testid="take-undo">
      <p role="status" className="min-w-0 break-words text-sm text-ink/70">
        Removed {removed.entry.name}, {takeWhen(removed.entry.savedAt)}.
      </p>
      <button
        ref={undoRef}
        type="button"
        onClick={undo}
        aria-label={`Undo: put ${removed.entry.name} back on this device`}
        className="btn-tertiary min-h-11 shrink-0 px-3 text-sm"
      >
        Undo
      </button>
    </div>
  );

  if (list.length === 0)
    return undoRow || gone ? (
      <section aria-label="Your saved takes" className="mt-6 print:hidden" data-testid="saved-takes">
        {undoRow}
        {gone && <p role="status" className="mt-2 text-sm text-ink/70">{gone}</p>}
      </section>
    ) : null;

  const open = async (e: TakeEntry) => {
    const file = await openSavedTake(e.id);
    if (!file) setGone("That take is no longer saved on this device, so it was taken off the list.");
    return file;
  };

  const openPlan = (id: string) => {
    setGone(null);
    setRemoved(null);
    void openRecentPlan(id).then((saved) => {
      if (saved) onOpenPlan?.(saved);
      else setGone("That plan is no longer saved on this device, so it was taken off the list.");
    });
  };

  const best = bestTake(list, roomSize);

  return (
    <section aria-labelledby="takes-heading" className="mt-6 print:hidden" data-testid="saved-takes">
      <h2 id="takes-heading" className="text-lg font-extrabold">
        Your saved takes
      </h2>
      <p className="mt-1 text-sm text-ink/70">Videos you recorded here, kept on this device only.{list.length > 1 ? ` The last ${list.length}, newest first.` : ""}</p>
      <ul ref={listRef} className="mt-3 divide-y divide-ink/10 overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-ink/10">
        {list.map((e) => {
          const when = takeWhen(e.savedAt);
          const details = [when, e.durationSec ? formatDuration(e.durationSec) : null, takeSize(e.size)].filter(Boolean).join(" · ");
          const made = planForTake(recents, e);
          const fit = takeFit(e.durationSec, roomSize);
          return (
            <li key={e.id} data-take-id={e.id} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:flex-wrap sm:items-center">
              <div className="flex min-w-0 flex-1 items-start gap-3">
                <TakeThumb id={e.id} durationSec={e.durationSec} />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-bold leading-snug">{e.name}</p>
                  <p className="text-sm text-ink/70">{details}</p>
                  {best?.id === e.id && (
                    <p data-testid="take-best" className="mt-1">
                      <span
                        aria-hidden="true"
                        className="inline-flex max-w-full items-center gap-1 break-words rounded-full bg-ink px-2 py-0.5 text-xs font-bold text-white"
                      >
                        <svg viewBox="0 0 20 20" className="h-3.5 w-3.5 shrink-0" fill="currentColor">
                          <path d="M10 2.5l2.2 4.6 5 .7-3.6 3.5.9 5-4.5-2.4-4.5 2.4.9-5L2.8 7.8l5-.7L10 2.5z" />
                        </svg>
                        {best.text}
                      </span>
                      <span className="sr-only">{best.aria}</span>
                    </p>
                  )}
                  {fit && (
                    <p data-testid="take-fit" data-tone={fit.tone} className="mt-1">
                      <span
                        aria-hidden="true"
                        className={`inline-block max-w-full break-words rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ${FIT_STYLE[fit.tone]}`}
                      >
                        {fit.text}
                      </span>
                      <span className="sr-only">{fit.aria}</span>
                    </p>
                  )}
                  {made && (
                    <p data-testid="take-plan" className="mt-1 flex items-start gap-1.5 text-sm font-semibold text-ink">
                      <svg aria-hidden="true" viewBox="0 0 20 20" className="mt-0.5 h-4 w-4 shrink-0 text-accent-dark" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="m4.5 10.5 3.5 3.5 7.5-8" />
                      </svg>
                      <span className="min-w-0 break-words">{takePlanLine(made)}</span>
                    </p>
                  )}
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <button
                  type="button"
                  onClick={() => {
                    setRemoved(null);
                    setWatching((cur) => nextOpenTake(cur, e.id));
                  }}
                  aria-expanded={openId === e.id}
                  aria-controls={`take-preview-${e.id}`}
                  aria-label={takeWatchLabels(openId === e.id, e.name).aria}
                  className="btn-secondary min-h-11 shrink-0 px-3 text-sm"
                >
                  {takeWatchLabels(openId === e.id, e.name).text}
                </button>
                <SaveVideoButton
                  getFile={() => open(e)}
                  ariaLabel={`Save video ${e.name}`}
                  className="btn-secondary min-h-11 px-3 text-sm"
                />
                {made && onOpenPlan && (
                  <button
                    type="button"
                    onClick={() => openPlan(made.id)}
                    aria-label={`Open plan made from ${e.name}`}
                    className="btn-secondary min-h-11 shrink-0 px-3 text-sm"
                  >
                    Open plan
                  </button>
                )}
                {onUse && (
                  <button
                    type="button"
                    onClick={() => {
                      setRemoved(null);
                      void open(e).then((file) => file && onUse(file));
                    }}
                    aria-label={`Use ${e.name} for a new plan`}
                    className="btn-tertiary min-h-11 shrink-0 px-3 text-sm"
                  >
                    Use
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => remove(e)}
                  aria-label={`Remove ${e.name}, ${when}, from this device`}
                  className="btn-tertiary min-h-11 shrink-0 px-3 text-sm"
                >
                  Remove
                </button>
              </div>
              {openId === e.id && (
                <div id={`take-preview-${e.id}`} className="w-full sm:basis-full">
                  <TakePreview
                    id={e.id}
                    name={e.name}
                    onMissing={() => {
                      setWatching(null);
                      setGone("That take is no longer saved on this device, so it was taken off the list.");
                    }}
                  />
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {undoRow}
      {gone && (
        <p role="status" className="mt-2 text-sm text-ink/70">
          {gone}
        </p>
      )}
    </section>
  );
}
