import { useEffect, useRef, useState } from "react";
import type { Box, Issue, PlanFrame, PlanReview, WorkPlan, WorkStep } from "@/lib/types";
import { ProofFrame } from "./ProofFrame";
import { verdictFor, verdictKind, supportedScope } from "@/lib/review";
import { tierFixed, tierFixedSr } from "@/lib/client/tierFixed";
import { boxSource, coverageNote, groupByTier, issueExtras, issueTier, TIER_HINT, TIER_LABEL, type Tier, type WatchItem } from "@/lib/planExtras";
import { checklistRows } from "@/lib/checklist";
import { areaProblemRanks, areaProblemsLabel } from "@/lib/client/checklistLinks";
import { shareLabel, type CostShare } from "@/lib/costShares";
import { PrintOpenDetails } from "./PrintOpenDetails";
import { fixedInLabel, problemAnchor, stepAnchor, stepsFixing } from "@/lib/client/stepLinks";
import { allStepsDone } from "@/lib/client/stepProgress";
import { problemsFixed, type ProblemsFixed } from "@/lib/client/problemsFixed";
import {
  activeProblemFilter,
  filterProblems,
  problemFilterAnnouncement,
  problemFilterOptions,
  type ProblemFilterMode,
  type ProblemFilterOption,
} from "@/lib/client/problemFilter";
import { useDoneSteps } from "@/lib/client/useDoneSteps";
import { problemShareTitle, problemToText } from "@/lib/client/problemText";
import { canShareFiles, sharePlanText, type ShareResult } from "@/lib/client/planText";
import { getProofPhoto, withPhotoLine } from "@/lib/client/proofPhoto";
import { keepInViewDelta, stickyLine } from "@/lib/client/keepInView";
import { prefersShareSheet } from "@/lib/client/savePlanPdf";
import { problemsShareTitle, problemsToText, sendShownLabel } from "@/lib/client/problemsText";
import { sendWatchLabel, watchShareTitle, watchToText } from "@/lib/client/watchText";
import { loadWatchChecked, saveWatchChecked, toggleWatchChecked, watchCheckLabel, watchCheckedLine } from "@/lib/client/watchChecked";

/**
 * The Problems section body (richer findings, items 2, 6 and 7): problems grouped into Fix now / Fix soon /
 * Can wait (from the server's tier, else severity), each card with where it is, what the photo shows, its
 * reviewer state (backed, partly backed, not backed) and its share of the cost. Then the plan's coverage note,
 * "Worth a closer look" (collapsed, lower confidence), and the checklist of areas looked at. Every optional
 * field is read through planExtras/costShares, so today's plans render the same cards as before.
 */

const SEVERITY_BORDER: Record<Issue["severity"], string> = {
  high: "border-l-red-600",
  medium: "border-l-amber-500",
  low: "border-l-ink/25",
};
const SEVERITY_LABEL: Record<Issue["severity"], string> = { high: "High", medium: "Medium", low: "Low" };

/** Same hues as the severity border on each card. */
const TIER_DOT: Record<Tier, string> = { urgent: "bg-red-600", soon: "bg-amber-500", later: "bg-ink/25" };

function SaidBadge({ issue, narrated }: { issue: Issue; narrated: boolean }) {
  if (!narrated) return <span className="rounded-full bg-ink/10 px-2 py-0.5 text-xs font-semibold">Seen on camera</span>;
  if (issue.unmentioned)
    return <span className="rounded-full bg-accent-dark px-2 py-0.5 text-xs font-bold text-white">You didn&apos;t mention this</span>;
  if (issue.status === "mentioned_not_seen")
    return <span className="rounded-full bg-ink/10 px-2 py-0.5 text-xs font-semibold">You said it, check in person</span>;
  return (
    <span className="rounded-full bg-ink/10 px-2 py-0.5 text-xs font-semibold">
      You said it{issue.mention ? ` at ${issue.mention.saidAtSec.toFixed(0)} s` : ""}
    </span>
  );
}

function PinIcon() {
  return (
    <svg aria-hidden viewBox="0 0 20 20" className="mt-0.5 h-4 w-4 shrink-0 text-ink/60" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10 17.5s-5-4.3-5-8.5a5 5 0 0 1 10 0c0 4.2-5 8.5-5 8.5Z" />
      <circle cx="10" cy="9" r="1.7" />
    </svg>
  );
}

function EyeIcon() {
  return (
    <svg aria-hidden viewBox="0 0 20 20" className="mt-0.5 h-4 w-4 shrink-0 text-ink/60" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M1.8 10S5 4.5 10 4.5 18.2 10 18.2 10 15 15.5 10 15.5 1.8 10 1.8 10Z" />
      <circle cx="10" cy="10" r="2.3" />
    </svg>
  );
}

/** Where it is and what the photo shows, as two quiet lines. Nothing when neither is sent. */
function WhereAndWhat({ area, evidence }: { area?: string; evidence?: string }) {
  if (!area && !evidence) return null;
  return (
    <dl className="mt-2 flex flex-col gap-1 text-sm text-ink/75">
      {area && (
        <div className="flex gap-1.5">
          <PinIcon />
          <dt className="sr-only">Where</dt>
          <dd className="min-w-0">{area}</dd>
        </div>
      )}
      {evidence && (
        <div className="flex gap-1.5">
          <EyeIcon />
          <dt className="sr-only">Photo shows</dt>
          <dd className="min-w-0">
            <span aria-hidden className="font-semibold text-ink/80">Photo shows: </span>
            {evidence}
          </dd>
        </div>
      )}
    </dl>
  );
}

/** "Fixed in step 3" under a problem, each step number a link down to that step in the work order. */
function FixedIn({ orders, done = false }: { orders: number[]; done?: boolean }) {
  const label = fixedInLabel(orders);
  if (!label) return null;
  const words = orders.length === 1 ? "Fixed in step" : "Fixed in steps";
  return (
    <p className="mt-2 flex flex-wrap items-center gap-x-1.5 text-sm text-ink/75" data-testid="fixed-in">
      <svg aria-hidden viewBox="0 0 20 20" className="h-4 w-4 shrink-0 text-safe-dark" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M4 10.5l4 4 8-9" />
      </svg>
      <span>{words}</span>
      {orders.map((n, i) => (
        <span key={n} className="inline-flex items-center gap-x-1.5">
          <a
            href={`#${stepAnchor(n)}`}
            className="inline-flex min-h-6 min-w-6 items-center justify-center font-semibold text-accent-dark underline underline-offset-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-dark"
            aria-label={`step ${n}`}
          >
            {n}
          </a>
          {i < orders.length - 2 && <span aria-hidden className="-ml-1.5">,</span>}
          {i === orders.length - 2 && <span aria-hidden>and</span>}
        </span>
      ))}
      {done && (
        <span className="ml-1 inline-flex min-h-6 items-center rounded-full bg-safe-dark px-2 text-xs font-semibold text-white" data-testid="fixed-in-done">
          {orders.length === 1 ? "Step done" : "Steps done"}
        </span>
      )}
    </p>
  );
}

const SEND_STATUS: Record<Exclude<ShareResult, "shared">, string> = {
  copied: "Copied. Paste it into a message.",
  cancelled: "",
  failed: "Couldn't share from this browser.",
};

/** What "Send this problem" can attach: the proof frame and its outline, drawn as on screen. */
interface ProblemPhoto {
  frame: PlanFrame | undefined;
  box: Box | undefined;
  dashed: boolean;
}

/**
 * Sends just this problem (problemText.ts) by the phone's share sheet, else the clipboard, so one problem can go to
 * the one person who will fix it. When the share sheet takes files, the proof photo goes along with the problem
 * outlined (proofPhoto.ts), built ahead of the tap. Hidden in print.
 */
function SendProblemButton({ issue, text, photo }: { issue: Issue; text: () => string; photo?: ProblemPhoto }) {
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ready = useRef<File | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  const frameUrl = photo?.frame?.url;
  const boxKey = photo?.box?.join(",") ?? "";
  useEffect(() => {
    ready.current = null;
    if (!photo?.frame || !prefersShareSheet()) return;
    const probe = new File([new Uint8Array([255, 216, 255])], "probe.jpg", { type: "image/jpeg" });
    if (!canShareFiles(navigator, [probe])) return;
    let live = true;
    const run = () =>
      void getProofPhoto(photo.frame, photo.box, { rank: issue.rank, title: issue.title, dashed: photo.dashed }).then((file) => {
        if (live) ready.current = file;
      });
    const t = setTimeout(run, 600 + issue.rank * 150);
    return () => {
      live = false;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frameUrl, boxKey, photo?.dashed, issue.rank, issue.title]);
  async function onSend() {
    if (busy) return;
    setBusy(true);
    setStatus("");
    const body = text();
    const file = ready.current;
    const attach = file ? { files: [file], text: withPhotoLine(body, Boolean(photo?.box)) } : null;
    const result = await sharePlanText(problemShareTitle(issue), body, navigator, prefersShareSheet(), attach);
    setBusy(false);
    if (result === "shared") return;
    setStatus(SEND_STATUS[result]);
    if (timer.current) clearTimeout(timer.current);
    if (result === "copied") timer.current = setTimeout(() => setStatus(""), 4000);
  }
  return (
    <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 print:hidden">
      <button
        type="button"
        onClick={onSend}
        disabled={busy}
        data-testid="send-problem"
        className="inline-flex min-h-11 items-center gap-2 rounded-full border border-ink/20 bg-white px-3.5 text-sm font-semibold text-ink hover:border-ink/40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-dark disabled:opacity-60"
      >
        <svg aria-hidden="true" viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M17.5 2.5 9 11M17.5 2.5 12 17.5l-3-6.5-6.5-3 15-5.5Z" />
        </svg>
        Send this problem<span className="sr-only"> #{issue.rank}</span>
      </button>
      <p role="status" aria-live="polite" className="text-sm text-ink/70">
        {status}
      </p>
    </div>
  );
}

function IssueCard({
  issue,
  frames,
  narrated,
  review,
  masks,
  sample,
  cost,
  fixedIn = [],
  fixedDone = false,
  titleLevel = 4,
  spaceName,
  workOrder,
}: {
  spaceName?: string;
  workOrder?: WorkPlan["workOrder"];
  /** Every step that fixes this problem is ticked off in the work order. */
  fixedDone?: boolean;
  titleLevel?: 3 | 4;
  /** Orders of the work steps that fix this problem; each becomes a link down to that step. */
  fixedIn?: number[];
  issue: Issue;
  frames: PlanFrame[];
  narrated: boolean;
  review: PlanReview | undefined;
  masks: boolean;
  sample: boolean;
  cost?: CostShare;
}) {
  const proof = issue.proofFrames?.[0];
  const verdict = verdictFor(review, issue);
  const kind = verdictKind(verdict);
  const scope = supportedScope(verdict);
  const { area, evidence } = issueExtras(issue);
  const seen = issue.status !== "mentioned_not_seen";
  return (
    <li
      id={problemAnchor(issue.rank)}
      className={`sw-land min-w-0 scroll-mt-32 rounded-2xl border-l-4 bg-white p-4 shadow-sm break-inside-avoid ${SEVERITY_BORDER[issue.severity]} ${
        seen ? "md:grid md:grid-cols-[minmax(0,1fr)_minmax(0,17rem)] md:items-start md:gap-4" : ""
      }`}
    >
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          {cost && (
            <span className="order-last ml-auto hidden text-sm font-semibold text-ink tabular-nums sm:inline" data-testid="issue-cost">
              <span className="font-medium text-ink/65">Share of cost </span>
              {shareLabel(cost)}
            </span>
          )}
          <span className="text-lg font-extrabold tabular-nums">#{issue.rank}</span>
          <span className="text-xs font-semibold uppercase tracking-wide text-ink/70">{SEVERITY_LABEL[issue.severity]} priority</span>
          <SaidBadge issue={issue} narrated={narrated} />
          {kind === "not_shown" && (
            <span className="rounded-full border border-amber-800 bg-amber-50 px-2 py-0.5 text-xs font-bold text-amber-900">Unverified</span>
          )}
          {kind === "partly" && (
            <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-bold text-amber-900">Partly backed</span>
          )}
        </div>
        {titleLevel === 3 ? (
          <h3 className="mt-2 text-lg font-bold leading-snug">{issue.title}</h3>
        ) : (
          <h4 className="mt-2 text-lg font-bold leading-snug">{issue.title}</h4>
        )}
        {cost && (
          <p className="mt-1 text-sm font-semibold text-ink tabular-nums sm:hidden" aria-hidden>
            <span className="font-medium text-ink/65">Share of cost </span>
            {shareLabel(cost)}
          </p>
        )}
        <p className="mt-1 text-sm text-ink/75">{issue.detail}</p>
        <WhereAndWhat area={area} evidence={evidence} />
        <FixedIn orders={fixedIn} done={fixedDone} />
        {kind === "not_shown" && verdict?.reason && (
          <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
            <span className="font-semibold">Not backed by a photo: </span>
            {verdict.reason}
          </p>
        )}
        {kind === "partly" && (scope || verdict?.reason) && (
          <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-950">
            <span className="font-semibold">Partly backed: </span>
            {scope ? `the photos show ${scope.replace(/^(the )?photos? shows? /i, "")}` : verdict?.reason}
            {scope && verdict?.reason ? <span className="mt-0.5 block text-amber-900/80">{verdict.reason}</span> : null}
          </p>
        )}
        <SendProblemButton
          issue={issue}
          text={() => problemToText(issue, { narrated, verdict, workOrder, spaceName, sample })}
          photo={
            seen
              ? { frame: frames[proof?.frameIndex ?? issue.frameIndex], box: proof?.box, dashed: !masks && boxSource(proof) !== "sam" }
              : undefined
          }
        />
      </div>
      {seen && (
        <div className="mt-3 min-w-0 md:mt-0">
          <ProofFrame
            frame={frames[proof?.frameIndex ?? issue.frameIndex]}
            box={proof?.box}
            boxSource={boxSource(proof)}
            caption={proof?.caption}
            outlineUnavailable={!masks}
            frameOnlyLabel={sample ? "Frame only" : undefined}
            group="problems"
          />
        </div>
      )}
    </li>
  );
}

export function ProblemList({
  plan,
  issues,
  watch,
  narrated,
  review,
  masks,
  sample,
  issueCosts,
}: {
  plan: WorkPlan;
  /** Ranked problems (watch items already taken out). */
  issues: Issue[];
  watch: WatchItem[];
  narrated: boolean;
  review: PlanReview | undefined;
  masks: boolean;
  sample: boolean;
  issueCosts: Map<number, CostShare> | null;
}) {
  const frames = plan.frames ?? [];
  const { done } = useDoneSteps(plan);
  const [chosenFilter, setChosenFilter] = useState<ProblemFilterMode>("all");
  // Options appear only when they would actually narrow the list; "Still to fix" follows the ticks live and the
  // list falls back to every problem once the chosen option stops narrowing (say, the last problem gets fixed).
  const filterCtx = { narrated, workOrder: plan.workOrder, done };
  const filterOptions = problemFilterOptions(issues, filterCtx);
  const filterMode = activeProblemFilter(chosenFilter, filterOptions);
  const filtered = filterMode !== "all";
  const shown = filterProblems(issues, filterMode, filterCtx);
  const groups = groupByTier(shown);
  // A "#problem-N" link elsewhere on the plan (fix first, work steps, walk timeline) must still land when the filter
  // hides that card: show every problem again, then jump to it.
  useEffect(() => {
    if (!filtered) return;
    const onClick = (e: MouseEvent) => {
      const link = (e.target as Element | null)?.closest?.('a[href^="#problem-"]');
      const id = link?.getAttribute("href")?.slice(1);
      if (!id || document.getElementById(id)) return;
      e.preventDefault();
      setChosenFilter("all");
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          document.getElementById(id)?.scrollIntoView({ block: "start" });
          history.replaceState(null, "", `#${id}`);
        }),
      );
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [filtered]);
  const note = coverageNote(plan);
  const fixedTally = problemsFixed(issues, plan.workOrder, done);
  // Tier headings only help once there is more than one problem; a single card reads fine alone.
  const showTiers = shown.length > 1;
  const showChecklist = [...issues, ...watch].some((i) => typeof (i as { checklistKey?: unknown }).checklistKey === "string");
  return (
    <>
      {issueCosts && (
        <p className="mb-4 text-sm text-ink/70">Each problem shows its share of the rough cost. Shared supplies are split, and the shares add up to the total.</p>
      )}
      {fixedTally && <FixedTally tally={fixedTally} />}
      {filterOptions.length > 0 && (
        <ProblemFilter options={filterOptions} mode={filterMode} onChange={setChosenFilter}>
          {filterMode !== "all" && (
            <SendShownButton
              count={shown.length}
              title={problemsShareTitle(filterMode, plan.spaceName)}
              text={() => problemsToText(shown, filterMode, { total: issues.length, spaceName: plan.spaceName, workOrder: plan.workOrder, sample })}
            />
          )}
        </ProblemFilter>
      )}
      {showTiers ? (
        <div className="flex flex-col gap-8">
          {groups.map((g) => (
            <section key={g.tier} aria-labelledby={`tier-${g.tier}`}>
              <div className="mb-3 flex items-baseline gap-2">
                <span aria-hidden className={`h-2.5 w-2.5 shrink-0 translate-y-[-1px] rounded-full ${TIER_DOT[g.tier]}`} />
                <h3 id={`tier-${g.tier}`} className="text-base font-extrabold">
                  {TIER_LABEL[g.tier]} <span className="font-semibold text-ink/60 tabular-nums">· {g.issues.length}</span>
                  <TierFixedTag issues={g.issues} tier={g.tier} workOrder={plan.workOrder} done={done} />
                </h3>
              </div>
              <p className="-mt-2 mb-3 pl-[1.125rem] text-sm text-ink/65">{TIER_HINT[g.tier]}</p>
              <ol className="flex flex-col gap-3">
                {g.issues.map((issue) => (
                  <IssueCard key={issue.rank} issue={issue} frames={frames} narrated={narrated} review={review} masks={masks} sample={sample} cost={issueCosts?.get(issue.rank)} fixedIn={stepsFixing(plan.workOrder, issue.rank)} fixedDone={allStepsDone(stepsFixing(plan.workOrder, issue.rank), done)} spaceName={plan.spaceName} workOrder={plan.workOrder} />
                ))}
              </ol>
            </section>
          ))}
        </div>
      ) : (
        <ol className="flex flex-col gap-3">
          {shown.map((issue) => (
            <IssueCard key={issue.rank} titleLevel={3} issue={issue} frames={frames} narrated={narrated} review={review} masks={masks} sample={sample} cost={issueCosts?.get(issue.rank)} fixedIn={stepsFixing(plan.workOrder, issue.rank)} fixedDone={allStepsDone(stepsFixing(plan.workOrder, issue.rank), done)} spaceName={plan.spaceName} workOrder={plan.workOrder} />
          ))}
        </ol>
      )}

      {note && (
        <p className="mt-4 flex items-start gap-2 rounded-2xl bg-white p-4 text-sm text-ink/70" data-testid="coverage-note">
          <svg aria-hidden viewBox="0 0 20 20" className="mt-0.5 h-4 w-4 shrink-0 text-ink/60" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
            <circle cx="10" cy="10" r="7.5" />
            <path d="M10 9v4.5M10 6.3v.2" />
          </svg>
          <span>
            <span className="font-semibold text-ink">Why {issues.length === 1 ? "only one problem" : issues.length === 0 ? "no problems" : `only ${issues.length} problems`}: </span>
            {note}
          </span>
        </p>
      )}

      {watch.length > 0 && <WatchList items={watch} frames={frames} masks={masks} sample={sample} spaceName={plan.spaceName} />}
      {showChecklist && <Checklist issues={issues} watch={watch} />}
    </>
  );
}

/** "· 1 fixed" / "· all fixed" after a tier heading once ticked-off steps fix problems in it. */
function TierFixedTag({ issues, tier, workOrder, done }: { issues: Issue[]; tier: Tier; workOrder: WorkStep[]; done: readonly number[] }) {
  const t = tierFixed(issues, workOrder, done);
  if (!t) return null;
  return (
    <span className={`font-semibold tabular-nums ${t.all ? "text-safe-dark" : "text-ink/65"}`} data-testid={`tier-fixed-${tier}`}>
      {" "}
      <span aria-hidden>· {t.all ? "✓ " : ""}{t.label}</span>
      <span className="sr-only">, {tierFixedSr(t)}</span>
    </span>
  );
}

/**
 * "2 of 5 problems fixed" with a bar, above the problems once any work step is ticked off, so the list says how far
 * the work has come. Follows the ticks live (useDoneSteps). Problems no step fixes are named in a quieter note.
 */
function FixedTally({ tally }: { tally: ProblemsFixed }) {
  const all = tally.fixed === tally.total;
  return (
    <div className="mb-5 rounded-2xl bg-white p-4" data-testid="problems-fixed">
      <p className="flex flex-wrap items-baseline gap-x-2 text-sm">
        <span className={`font-semibold tabular-nums ${all ? "text-safe-dark" : "text-ink"}`}>{tally.line}</span>
        <span className="text-ink/65">
          {all ? "Every step that fixes them is done." : "A problem is fixed once every step that fixes it is done."}
        </span>
      </p>
      <div aria-hidden className="mt-2.5 h-2 w-full overflow-hidden rounded-full bg-ink/10">
        <div className="h-full rounded-full bg-safe-dark transition-[width] duration-300 motion-reduce:transition-none" style={{ width: `${tally.percent}%` }} />
      </div>
      {tally.untracked > 0 && (
        <p className="mt-2 text-xs text-ink/65" data-testid="problems-fixed-untracked">
          {tally.untracked === 1
            ? "1 problem isn’t in a work step, so it can’t be ticked off here."
            : `${tally.untracked} problems aren’t in a work step, so they can’t be ticked off here.`}
        </p>
      )}
    </div>
  );
}

/**
 * Toggle above the problems: every problem, only the ones the video showed and the narration never mentioned, or
 * only the ones not fixed yet by ticked-off work steps. Each narrowing option shows only while it narrows. Buttons
 * with aria-pressed, 44 px tall, hidden in print so a printout always lists every problem.
 */
function ProblemFilter({ options, mode, onChange, children }: { options: ProblemFilterOption[]; mode: ProblemFilterMode; onChange: (mode: ProblemFilterMode) => void; children?: React.ReactNode }) {
  const base =
    "inline-flex min-h-11 min-w-0 flex-auto items-center justify-center gap-1.5 rounded-full px-3 text-center text-sm font-semibold leading-tight focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-dark sm:flex-none sm:px-4";
  const on = "bg-ink text-white";
  const off = "text-ink/75 hover:bg-ink/5";
  // Switching can shrink or grow the list by many cards. Keep the filter where the reader can see it: just under the
  // sticky header and chips, never half-covered by them and never left far above or below the window.
  const ref = useRef<HTMLDivElement>(null);
  const pick = (next: ProblemFilterMode) => {
    if (next === mode) return;
    onChange(next);
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        const el = ref.current;
        if (!el) return;
        const delta = keepInViewDelta(el.getBoundingClientRect(), stickyLine(), window.innerHeight);
        if (delta === 0) return;
        const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
        window.scrollBy({ top: delta, behavior: reduce ? "auto" : "smooth" });
      }),
    );
  };
  return (
    <div ref={ref} className="mb-5 scroll-mt-32 sm:flex sm:flex-wrap sm:items-center sm:gap-x-3 sm:gap-y-2 print:hidden" data-testid="unmentioned-filter">
      <div role="group" aria-label="Which problems to show" className="flex w-full gap-1 rounded-full border border-ink/15 bg-white p-1 sm:inline-flex sm:w-auto">
        {options.map((o) => (
          <button key={o.mode} type="button" aria-pressed={mode === o.mode} className={`${base} ${mode === o.mode ? on : off}`} onClick={() => pick(o.mode)} data-filter={o.mode}>
            <span className="text-balance">
              {o.label}&nbsp;<span className="tabular-nums">{o.count}</span>
            </span>
          </button>
        ))}
      </div>
      <p className="sr-only" aria-live="polite">
        {problemFilterAnnouncement(mode, options)}
      </p>
      {children}
    </div>
  );
}

/**
 * Beside the filter (under it on phones) while it narrows the list: sends just the problems it is showing as one short list
 * (problemsText.ts), by the phone's share sheet, else the clipboard. Hidden in print with the filter.
 */
function SendShownButton({ count, title, text }: { count: number; title: string; text: () => string | null }) {
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  async function onSend() {
    const body = text();
    if (busy || !body) return;
    setBusy(true);
    setStatus("");
    const result = await sharePlanText(title, body, navigator, prefersShareSheet());
    setBusy(false);
    if (result === "shared") return;
    setStatus(SEND_STATUS[result]);
    if (timer.current) clearTimeout(timer.current);
    if (result === "copied") timer.current = setTimeout(() => setStatus(""), 4000);
  }
  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 sm:mt-0">
      <button
        type="button"
        onClick={onSend}
        disabled={busy}
        data-testid="send-shown-problems"
        className="inline-flex min-h-11 items-center gap-2 rounded-full border border-ink/20 bg-white px-3.5 text-sm font-semibold text-ink hover:border-ink/40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-dark disabled:opacity-60"
      >
        <svg aria-hidden="true" viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M17.5 2.5 9 11M17.5 2.5 12 17.5l-3-6.5-6.5-3 15-5.5Z" />
        </svg>
        {sendShownLabel(count)}
        <span className="sr-only"> {count === 1 ? "problem" : "problems"}</span>
      </button>
      <p role="status" aria-live="polite" className="text-sm text-ink/70">
        {status}
      </p>
    </div>
  );
}

/**
 * "Worth a closer look": lower-confidence finds, collapsed by default, each with its photo. Each find has a
 * "Mark checked" toggle for whoever looks at it in person, kept on this device per plan (watchChecked.ts).
 */
function WatchList({ items, frames, masks, sample, spaceName }: { items: WatchItem[]; frames: PlanFrame[]; masks: boolean; sample: boolean; spaceName?: string }) {
  const [checked, setChecked] = useState<number[]>([]);
  const watchKeyPlan = { spaceName, watch: items };
  const planRef = useRef(watchKeyPlan);
  planRef.current = watchKeyPlan;
  const titles = items.map((w) => w.title).join("\u0001");
  useEffect(() => {
    setChecked(loadWatchChecked(planRef.current));
  }, [spaceName, titles]);
  function onToggle(index: number) {
    const next = toggleWatchChecked(checked, index);
    setChecked(next);
    saveWatchChecked(planRef.current, next);
  }
  const checkedLine = watchCheckedLine(checked.length, items.length);
  return (
    <PrintOpenDetails className="group mt-6 rounded-2xl border border-ink/10 bg-white" data-testid="watch-list">
      <summary className="flex min-h-14 cursor-pointer list-none items-center gap-3 rounded-2xl p-5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent [&::-webkit-details-marker]:hidden">
        <svg aria-hidden viewBox="0 0 20 20" className="h-4 w-4 shrink-0 text-ink/60 motion-safe:transition-transform group-open:rotate-90">
          <path d="M7 4l6 6-6 6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2 font-semibold">
            Worth a closer look
            <span className="rounded-full bg-ink/10 px-2 py-0.5 text-xs font-bold tabular-nums">{items.length}</span>
          </span>
          <span className="mt-0.5 block text-sm text-ink/65">Lower confidence. Not in the ranked list or the work order; check these in person.</span>
          {checkedLine && (
            <span className="mt-1 block text-sm font-semibold text-safe-dark" data-testid="watch-checked-summary">
              {checkedLine}
            </span>
          )}
        </span>
      </summary>
      <ul className="flex flex-col gap-3 px-5 pb-5">
        {items.map((w, i) => {
          const proof = w.proofFrames?.[0];
          const isChecked = checked.includes(i);
          return (
            <li
              key={`${w.title}-${i}`}
              data-testid="watch-item"
              data-checked={isChecked ? "true" : "false"}
              className={`grid min-w-0 grid-cols-[minmax(0,1fr)_6.5rem] items-start gap-3 rounded-xl p-3 sm:grid-cols-[minmax(0,1fr)_10rem] ${isChecked ? "bg-safe-dark/[0.08]" : "bg-ink/[0.03]"}`}
            >
              <div className="min-w-0">
                <p className="font-bold leading-snug">{w.title}</p>
                {w.detail && <p className="mt-0.5 text-sm text-ink/75">{w.detail}</p>}
                <WhereAndWhat area={w.area} evidence={w.evidence} />
                {w.confidence !== undefined && (
                  <p className="mt-2 text-xs font-semibold uppercase tracking-wide text-ink/60">
                    {Math.round(w.confidence * 100)}% sure
                  </p>
                )}
                <button
                  type="button"
                  aria-pressed={isChecked}
                  aria-label={`${watchCheckLabel(isChecked)}: ${w.title}`}
                  onClick={() => onToggle(i)}
                  data-testid="watch-check"
                  className={`mt-3 inline-flex min-h-11 items-center gap-2 rounded-full border px-3.5 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-dark print:hidden ${
                    isChecked ? "border-safe-dark bg-safe-dark text-white" : "border-ink/20 bg-white text-ink hover:border-ink/40"
                  }`}
                >
                  <svg aria-hidden="true" viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    {isChecked ? <path d="M4.5 10.5l3.5 3.5 7.5-8" /> : <circle cx="10" cy="10" r="6.5" />}
                  </svg>
                  {watchCheckLabel(isChecked)}
                </button>
                {isChecked && <p className="mt-2 hidden text-sm font-semibold print:block">Checked in person</p>}
              </div>
              <div className="min-w-0">
                <ProofFrame
                  frame={frames[proof?.frameIndex ?? w.frameIndex]}
                  box={proof?.box}
                  boxSource={boxSource(proof)}
                  caption={proof?.caption ?? "Check this"}
                  outlineUnavailable={!masks}
                  frameOnlyLabel={sample ? "Frame only" : undefined}
                  compact
                  group="watch"
                />
              </div>
            </li>
          );
        })}
      </ul>
      <SendWatchButton count={items.length} title={watchShareTitle(spaceName)} text={() => watchToText(items, { spaceName, sample, checked })} />
    </PrintOpenDetails>
  );
}

/**
 * At the foot of the open "Worth a closer look" list: sends the lower-confidence finds as one short list (watchText.ts)
 * to whoever checks them in person, by the phone's share sheet, else the clipboard. Hidden in print.
 */
function SendWatchButton({ count, title, text }: { count: number; title: string; text: () => string | null }) {
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  async function onSend() {
    const body = text();
    if (busy || !body) return;
    setBusy(true);
    setStatus("");
    const result = await sharePlanText(title, body, navigator, prefersShareSheet());
    setBusy(false);
    if (result === "shared") return;
    setStatus(SEND_STATUS[result]);
    if (timer.current) clearTimeout(timer.current);
    if (result === "copied") timer.current = setTimeout(() => setStatus(""), 4000);
  }
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-5 pb-5 print:hidden">
      <button
        type="button"
        onClick={onSend}
        disabled={busy}
        data-testid="send-watch"
        className="inline-flex min-h-11 items-center gap-2 rounded-full border border-ink/20 bg-white px-3.5 text-sm font-semibold text-ink hover:border-ink/40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-dark disabled:opacity-60"
      >
        <svg aria-hidden="true" viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M17.5 2.5 9 11M17.5 2.5 12 17.5l-3-6.5-6.5-3 15-5.5Z" />
        </svg>
        {sendWatchLabel(count)}
      </button>
      <p role="status" aria-live="polite" className="text-sm text-ink/70">
        {status}
      </p>
    </div>
  );
}

/**
 * The areas the checklist covers. Areas that turned something up are listed first with their counts; the clear
 * ones follow as a compact row of ticks, so a phone screen isn't a wall of "nothing flagged". Shown only when the
 * plan step used the checklist (its problems carry a checklistKey).
 */
function Checklist({ issues, watch }: { issues: Issue[]; watch: WatchItem[] }) {
  const rows = checklistRows(issues as (Issue & { checklistKey?: unknown })[], watch as (WatchItem & { checklistKey?: unknown })[]);
  const hits = rows.filter((r) => r.found + r.watch > 0);
  const clear = rows.filter((r) => r.found + r.watch === 0);
  return (
    <section aria-labelledby="checklist-heading" className="mt-6 rounded-2xl border border-ink/10 bg-white p-5 break-inside-avoid" data-testid="checklist">
      <h3 id="checklist-heading" className="font-extrabold">
        What SightWork checked
      </h3>
      <p className="mt-0.5 text-sm text-ink/65">
        The plan step went through {rows.length} areas in every frame.{" "}
        {hits.length === 0 ? "Nothing was flagged." : `${hits.length} turned something up.`}
      </p>
      {hits.length > 0 && (
        <ul className="mt-3 divide-y divide-ink/10" aria-label="Areas with findings">
          {hits.map((r) => {
            const ranks = areaProblemRanks(issues as (Issue & { checklistKey?: unknown })[], r.id);
            return (
            <li key={r.id} className="py-2 text-sm" data-testid="checklist-area">
              <div className="flex min-h-7 items-center justify-between gap-3">
              <span className="flex min-w-0 items-center gap-2">
                <span aria-hidden className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-amber-100 text-amber-900">
                  <svg viewBox="0 0 16 16" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M8 4v4.5M8 11.5v.2" /></svg>
                </span>
                <span className="min-w-0 font-semibold">{r.label}</span>
              </span>
              <span className="shrink-0 text-right text-ink/70 tabular-nums">
                {r.found > 0 ? `${r.found} ${r.found === 1 ? "problem" : "problems"}` : null}
                {r.found > 0 && r.watch > 0 ? " · " : null}
                {r.watch > 0 ? `${r.watch} to check` : null}
              </span>
              </div>
              {ranks.length > 0 && (
                // Each number jumps to that problem's card, so the summary leads straight to the evidence.
                <div role="group" aria-label={areaProblemsLabel(r.label, ranks)} className="mt-1.5 flex flex-wrap gap-1.5 pl-7" data-testid="checklist-problems">
                  {ranks.map((n) => (
                      <a
                        key={n}
                        href={`#${problemAnchor(n)}`}
                        aria-label={`Problem ${n}`}
                        className="inline-flex min-h-8 min-w-8 items-center justify-center rounded-full border border-accent-dark/30 px-2 text-sm font-semibold text-accent-dark tabular-nums hover:border-accent-dark hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-dark"
                      >
                        #{n}
                      </a>
                  ))}
                </div>
              )}
            </li>
            );
          })}
        </ul>
      )}
      {clear.length > 0 && (
        <div className="mt-3 border-t border-ink/10 pt-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-ink/60">Nothing flagged</p>
          <ul className="mt-2 flex flex-wrap gap-1.5" aria-label="Areas with nothing flagged">
            {clear.map((r) => (
              <li key={r.id} className="inline-flex min-h-8 items-center gap-1.5 rounded-full bg-safe/10 px-2.5 text-sm text-safe-dark">
                <svg aria-hidden viewBox="0 0 16 16" className="h-3 w-3 shrink-0" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M3.5 8.5l3 3 6-7" /></svg>
                {r.label}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

/** Re-exported so PlanView can keep its stat row in step with the tiers. */
export { issueTier };
