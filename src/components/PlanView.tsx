import { useState } from "react";
import { noStepsCostLine, noStepsLine } from "@/lib/client/planEmpty";
import { WalkTimeline } from "./WalkTimeline";
import { AFTER_IMAGE_LABEL, masksAvailable, type Issue, type PlanFrame, type WorkPlan } from "@/lib/types";
import { noNarrationNote, noNarrationTag } from "@/lib/client/narrationNote";
import { ProofFrame } from "./ProofFrame";
import { BeforeAfter } from "./BeforeAfter";
import { SharePlanButton } from "./SharePlanButton";
import { ReadAloudButton } from "./ReadAloudButton";
import { TextSizeButton } from "./TextSizeButton";
import { ContrastButton } from "./ContrastButton";
import { DisplaySettings } from "./DisplaySettings";
import { PlanAgeNote } from "./PlanAgeNote";
import { AfterPictureNote } from "./AfterPictureNote";
import { WorkSteps } from "./WorkSteps";
import { FixFirst } from "./FixFirst";
import { NextUp } from "./NextUp";
import { SinceLastVisit } from "./SinceLastVisit";
import { MaterialsList } from "./MaterialsList";
import { PoweredByMeta } from "./PoweredByMeta";
import { SectionNav } from "./SectionNav";
import { BackToTop } from "./BackToTop";
import { JumpBack } from "./JumpBack";
import { SendCostButton } from "@/components/SendCostButton";
import { CostLeft } from "./CostLeft";
import { BudgetFit } from "./BudgetFit";
import { SendCountsButton } from "./SendCountsButton";
import { SendBeforeAfterButton } from "./SendBeforeAfterButton";
import { SaidVsSeenList } from "./SaidVsSeenList";
import { summaryMoreLine, summaryTitles } from "@/lib/client/summaryTitles";
import type { Example } from "@/lib/examples";
import { planReview, reviewLine, verdictKind } from "@/lib/review";
import { ProblemList } from "./ProblemList";
import { rankedIssues, watchItems } from "@/lib/planExtras";
import { issueCostShares, stepCostShares } from "@/lib/costShares";
import { COST_INDEX_LABEL, COST_INDEX_SOURCE, describeFactors, regionalFactors, stateFromRegion } from "@/lib/regionalCost";
import { livePricesLine, planLocation, SAID_VS_SEEN_HEADING, saidVsSeenTally } from "@/lib/client/planText";
import { problemAnchor } from "@/lib/client/stepLinks";
import { countMethodNote, countsFootnote, sharedCountMethod } from "@/lib/client/countMethod";

// Focus ring for the links on the dark summary card.
const SUMMARY_LINK_FOCUS = "focus:outline-none focus-visible:ring-4 focus-visible:ring-accent/50";

const usd = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const range = (r: [number, number], unit = "") => (r[0] === r[1] ? `${r[0]}${unit}` : `${r[0]}–${r[1]}${unit}`);

function Section({ title, children, id, className }: { title: React.ReactNode; children: React.ReactNode; id?: string; className?: string }) {
  return (
    <section id={id} className={className ? `mt-12 scroll-mt-32 md:mt-16 ${className}` : "mt-12 scroll-mt-32 md:mt-16"}>
      <h2 className="mb-6 text-xl font-extrabold">{title}</h2>
      {children}
    </section>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="rounded-2xl bg-white p-4 text-sm text-ink/70">{children}</p>;
}

/** A walkthrough with no speech: the said-vs-seen framing doesn't apply. */
export function isNarrated(plan: WorkPlan): boolean {
  return Boolean(plan.transcript?.trim()) || (plan.transcriptTurns?.length ?? 0) > 0;
}

/**
 * Quiet metadata row under the plan title, e.g. "78 s · 12 frames · narrated". The plan step writes generatedFrom as
 * "Walkthrough video, N frames, D s, narrated"; read the numbers from it, and fall back to the raw line if it doesn't parse.
 */
export function planMetaParts(plan: WorkPlan): string[] | null {
  const text = plan.generatedFrom ?? "";
  const secs = text.match(/(\d+(?:\.\d+)?)\s*s\b/);
  const frameCount = text.match(/(\d+)\s*frames?\b/);
  if (!secs && !frameCount) return null;
  const parts: string[] = [];
  if (secs) parts.push(`${Math.round(Number(secs[1]))} s`);
  const n = frameCount ? Number(frameCount[1]) : (plan.frames?.length ?? 0);
  if (n > 0) parts.push(`${n} ${n === 1 ? "frame" : "frames"}`);
  parts.push(isNarrated(plan) ? "narrated" : noNarrationTag(plan));
  return parts;
}

/** Where the after picture goes when there isn't one yet: the real frame, dimmed, with a plain note. */
function AfterSlot({ frame, sample = false }: { frame: PlanFrame | undefined; sample?: boolean }) {
  return (
    <figure className="relative overflow-hidden rounded-2xl bg-ink">
      {frame ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={frame.url} alt="" aria-hidden className="block aspect-video w-full object-cover opacity-30 blur-[2px]" />
      ) : (
        <div aria-hidden className="aspect-video w-full bg-gradient-to-br from-ink to-ink/70" />
      )}
      <figcaption className="absolute inset-0 flex flex-col items-center justify-center gap-1 p-4 text-center text-white">
        <span className="rounded-full bg-white/15 px-3 py-1 text-xs font-semibold uppercase tracking-wide">
          {sample ? "Real runs only" : "Coming soon"}
        </span>
        <span className="text-lg font-bold sm:text-xl">After picture</span>
        <span className="max-w-sm text-sm text-white/75">
          {sample
            ? "On a real run, Muse Image draws an AI concept of the finished space here. This sample was written by hand."
            : "An AI concept of the finished space will show here. The plan above is complete without it."}
        </span>
      </figcaption>
    </figure>
  );
}

/** The reviewer pass, in one line above the problems. Prints too, so the PDF carries it. */
function ReviewLine({ text, ok }: { text: string; ok: boolean }) {
  return (
    <p className="mb-4 flex items-start gap-2 rounded-xl border border-ink/10 bg-white px-4 py-3 text-sm text-ink/80 break-inside-avoid">
      <svg aria-hidden="true" viewBox="0 0 20 20" className={`mt-0.5 h-4 w-4 shrink-0 ${ok ? "text-safe-dark" : "text-amber-800"}`} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M10 2.5 4 5v4.5c0 3.6 2.6 6.6 6 8 3.4-1.4 6-4.4 6-8V5l-6-2.5Z" />
        {ok ? <path d="m7.2 10 2 2 3.6-3.8" /> : <path d="M10 6.5v4M10 13.3v.2" />}
      </svg>
      <span className="min-w-0">{text}</span>
    </p>
  );
}

export function PlanView({
  plan,
  videoName,
  example,
  savedAt,
  onMakeYourOwn,
}: {
  plan: WorkPlan;
  videoName: string | null;
  /** When this plan was saved on the device (set on a reopened plan); a week or more ago adds an "old plan" note. */
  savedAt?: string;
  /** Set when this plan was opened from the examples list: drives the "Real run" or "Sample" banner. */
  example?: Example;
  /** Example banner's "Make your own": back to the empty upload stage. */
  onMakeYourOwn?: () => void;
}) {
  // Where the read-aloud pace button goes: into the display settings (set once that box is on the page).
  const [speedHost, setSpeedHost] = useState<HTMLElement | null>(null);
  const frames = plan.frames ?? [];
  const narrated = isNarrated(plan);
  // Ranked problems only: anything the server marked watch: true shows under "Worth a closer look" instead.
  const issues = rankedIssues(plan);
  const watch = watchItems(plan);
  const issueCosts = issueCostShares(plan);
  const stepCosts = stepCostShares(plan);
  const metaParts = planMetaParts(plan);
  const location = planLocation(plan);
  const unmentioned = narrated ? rankedIssues(plan).filter((i) => i.unmentioned) : [];
  const hero = plan.heroFrameIndex !== undefined ? frames[plan.heroFrameIndex] : undefined;
  const masks = masksAvailable(plan);
  const sharedMethod = sharedCountMethod(plan.inventory, masks);
  // Hand-written samples (example cards, or the stand-in plan shown after a preview upload) never ran the
  // outline step, so their frames just say "Frame only".
  const sample = example?.kind === "sample" || (!example && plan.meta?.isExample === true);
  // Without SAM, any box on a proof frame came from the plan step itself, so call it a rough highlight.
  const roughBoxes = !masks && plan.issues.some((i) => i.proofFrames?.[0]?.box);
  const review = planReview(plan);
  // No work steps means nothing to price (the cost step needs at least one), so say that instead of "try again".
  const noStepsCost = sample ? null : noStepsCostLine(plan.workOrder.length, plan.materials.length);
  const reviewText = plan.issues.length > 0 ? reviewLine(review) : null;
  const slotFrame = hero ?? frames[plan.issues[0]?.frameIndex ?? 0] ?? frames[0];
  // Hero proof frame for the top of the plan when there's no after picture: the plan's hero frame, else the worst
  // problem's proof frame. It borrows that problem's box and caption only when it is the same frame.
  const topIssue = plan.issues.find((i) => i.status !== "mentioned_not_seen");
  const topIssueProof = topIssue?.proofFrames?.[0];
  const topIssueIndex = topIssueProof?.frameIndex ?? topIssue?.frameIndex;
  const topProofIndex = plan.heroFrameIndex !== undefined && hero ? plan.heroFrameIndex : topIssueIndex;
  const topProof =
    topProofIndex !== undefined && frames[topProofIndex]
      ? topProofIndex === topIssueIndex && topIssue
        ? { frame: frames[topProofIndex], box: topIssueProof?.box, caption: topIssueProof?.caption ?? topIssue.title }
        : { frame: frames[topProofIndex], box: undefined, caption: "Your walkthrough" }
      : undefined;
  // Summary stat row: never show a slot that can be empty, so "not mentioned" needs narration and cost needs a costRange.
  const stats: { label: string; value: string; accent?: boolean; small?: boolean }[] = [
    { label: narrated ? "Problems found" : "Problems found on camera", value: String(issues.length) },
    ...(narrated ? [{ label: "You didn't mention", value: String(unmentioned.length), accent: unmentioned.length > 0 }] : []),
    ...(plan.workOrder.length > 0 ? [{ label: "Work steps", value: String(plan.workOrder.length) }] : []),
    ...(plan.costRange ? [{ label: "Rough cost", value: `${usd(plan.costRange.low)}–${usd(plan.costRange.high)}`, small: true }] : []),
  ];

  // Summary card list: the problems the walk never named when there are any, else all of them; long lists stop at four.
  const summaryList = summaryTitles(unmentioned.length > 0 ? unmentioned : issues);
  const summaryMore = summaryMoreLine(summaryList.more);

  // Sticky section chips: one per section that actually renders, so no chip points at nothing.
  const showSaid = narrated && !!plan.saidVsSeen && plan.saidVsSeen.length > 0;
  // Problems, Counts, Steps and Materials carry how many they hold; an empty section shows just its name.
  const chips: { href: string; label: string; count?: number; track?: "steps" | "materials" | "problems" }[] = [
    { href: "#problems", label: "Problems", count: issues.length, track: "problems" },
    ...(showSaid ? [{ href: "#said-vs-saw", label: "Said vs saw" }] : []),
    { href: "#counts", label: "Counts", count: plan.inventory.length },
    { href: "#steps", label: "Steps", count: plan.workOrder.length, track: "steps" },
    { href: "#materials", label: "Materials", count: plan.materials.length, track: "materials" },
    ...(plan.costRange ? [{ href: "#cost", label: "Cost" }] : []),
  ];

  return (
    <article>
      {example ? (
        <ExampleBanner example={example} videoName={videoName} onMakeYourOwn={onMakeYourOwn} />
      ) : (
        plan.meta?.isExample && (
          <div className="mb-4 flex flex-col gap-3 rounded-xl bg-amber-100 px-4 py-3 text-sm text-amber-900 sm:flex-row sm:items-center sm:justify-between print:block">
            <p>
              <strong>Example plan.</strong>{" "}
              Sample data written by hand, not a real run
              {videoName ? `, shown because real analysis isn't on in this preview (your video "${videoName}" was not sent anywhere)` : ""}.
            </p>
            {onMakeYourOwn && (
              <button
                type="button"
                onClick={onMakeYourOwn}
                className="btn-primary shrink-0 self-start text-sm sm:self-auto print:hidden"
              >
                Make your own
              </button>
            )}
          </div>
        )
      )}

      <h1 id="plan-top" tabIndex={-1} className="scroll-mt-24 text-3xl font-extrabold leading-tight break-words outline-none sm:text-4xl">{plan.spaceName}</h1>
      {location && (
        <p className="mt-1 text-sm font-semibold text-ink/80 break-words" data-testid="plan-location">
          <span className="sr-only">Location: </span>
          {location}
        </p>
      )}
      {metaParts ? (
        <p className="mt-1 text-sm text-ink/70">
          <span className="sr-only">Walkthrough video: </span>
          {metaParts.join(" · ")}
        </p>
      ) : (
        plan.generatedFrom && <p className="mt-1 text-sm text-ink/70">{plan.generatedFrom}</p>
      )}

      <div className="flex flex-wrap items-start gap-x-3">
        <SharePlanButton plan={plan} sample={sample} example={example} />
        <ReadAloudButton plan={plan} speedHost={speedHost} />
        <DisplaySettings hostRef={setSpeedHost}>
          <TextSizeButton />
          <ContrastButton />
        </DisplaySettings>
      </div>
      {!sample && !example && !plan.meta?.isExample && <PlanAgeNote savedAt={savedAt} onFilmAgain={onMakeYourOwn} />}
      {!sample && !example && !plan.meta?.isExample && <AfterPictureNote plan={plan} onFilmAgain={onMakeYourOwn} />}
      {!sample && !example && !plan.meta?.isExample && <SinceLastVisit plan={plan} />}

      {plan.issues.length > 0 && (
        <div className="mt-5 rounded-2xl bg-ink p-5 text-white sm:p-6">
          {/* The stats go to the problem list; each named problem below goes straight to its own card. */}
          <a href="#problems" className={`block rounded-lg ${SUMMARY_LINK_FOCUS}`}>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-4 sm:flex sm:flex-wrap sm:gap-x-10">
              {stats.map((s) => (
                <div key={s.label} className="min-w-0">
                  <dt className="text-sm font-semibold text-white/80">{s.label}</dt>
                  <dd className={`font-extrabold leading-tight break-words ${s.small ? "text-2xl" : "text-4xl"} ${s.accent ? "text-accent" : "text-white"}`}>
                    {s.value}
                  </dd>
                </div>
              ))}
            </dl>
          </a>
          {unmentioned.length > 0 && <p className="mt-4 text-sm font-semibold text-white">Not mentioned:</p>}
          <ul className={`${unmentioned.length > 0 ? "mt-1.5" : "mt-4"} space-y-1 text-sm text-white/80`} data-testid="summary-titles">
            {summaryList.items.map((i) => (
              <li key={i.rank} className="min-w-0">
                <a href={`#${problemAnchor(i.rank)}`} className={`group flex min-w-0 gap-2 rounded py-0.5 ${SUMMARY_LINK_FOCUS}`}>
                  <span aria-hidden="true" className="w-6 shrink-0 font-semibold tabular-nums text-white/70">#{i.rank}</span>
                  <span className="min-w-0 break-words underline-offset-2 group-hover:underline">
                    <span className="sr-only">Problem {i.rank}: </span>
                    {i.title}
                  </span>
                </a>
              </li>
            ))}
          </ul>
          {summaryMore && (
            <p className="mt-1.5 text-sm font-semibold text-white/80">
              <a href="#problems" className={`rounded underline underline-offset-2 ${SUMMARY_LINK_FOCUS}`}>{summaryMore}</a>
            </p>
          )}
        </div>
      )}

      <FixFirst issues={issues} workOrder={plan.workOrder} stepCosts={stepCosts} issueCosts={issueCosts} spaceName={plan.spaceName} sample={sample || !!example || plan.meta?.isExample === true} />
      <NextUp plan={plan} />

      {!narrated && (
        <p className="mt-4 rounded-xl bg-white p-4 text-sm text-ink/70">
          {noNarrationNote(plan).lead} {noNarrationNote(plan).hint}
        </p>
      )}

      {narrated && plan.transcriptSummary && (
        <p className="mt-4 rounded-xl bg-white p-4 text-sm">
          <span className="font-semibold">What you asked for: </span>
          {plan.transcriptSummary}
        </p>
      )}

      {/* The after picture is the wow moment, so it sits right under the summary, but only when it exists. */}
      {plan.afterImageUrl && hero && (
        <Section title="Before and after" className="mt-6!">
          <BeforeAfter before={hero.url} after={plan.afterImageUrl} label={plan.afterImageLabel ?? AFTER_IMAGE_LABEL} />
          <SendBeforeAfterButton before={hero.url} after={plan.afterImageUrl} label={plan.afterImageLabel ?? AFTER_IMAGE_LABEL} spaceName={plan.spaceName} sample={sample || !!example || plan.meta?.isExample === true} />
        </Section>
      )}

      {plan.afterImageUrl && !hero && (
        <Section title="After the work" className="mt-6!">
          <figure className="overflow-hidden rounded-xl bg-ink">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={plan.afterImageUrl} alt="AI concept of the finished space" className="block aspect-[4/3] max-h-[70vh] w-full object-cover" />
            <figcaption className="bg-ink px-3 py-1.5 text-sm text-white/80">{plan.afterImageLabel ?? AFTER_IMAGE_LABEL}</figcaption>
          </figure>
        </Section>
      )}

      {/* No after picture: lead with the hero proof frame instead, so the top never shows an empty slot. */}
      {!plan.afterImageUrl && topProof && (
        <Section title="From your video" className="mt-6!">
          <ProofFrame frame={topProof.frame} box={topProof.box} caption={topProof.caption} outlineUnavailable={!masks} frameOnlyLabel={sample ? "Frame only" : undefined} priority />
        </Section>
      )}

      <SectionNav chips={chips} plan={plan} />
      <BackToTop targetId="plan-top" />
      <JumpBack />

      <Section title="Problems, worst first" id="problems">
        {plan.issues.length === 0 && <Empty>No problems found in the frames we looked at. Walk it in person before you sign off.</Empty>}
        {plan.issues.length > 0 && !masks && (
          <p className="mb-4 rounded-xl border border-ink/10 bg-white/70 px-4 py-3 text-sm text-ink/70">
            {sample
              ? "In this sample the dashed boxes are drawn by hand to show where each problem is. On a real run, SightWork marks them from your video."
              : roughBoxes
                ? "Exact outlines are off for this plan, so the dashed boxes are rough highlights from the plan step. Each problem still shows the frame it was found in."
                : "Outlines on the proof frames are off for this plan. Each problem still shows the frame it was found in."}
          </p>
        )}
        <WalkTimeline plan={plan} issues={issues} narrated={narrated} />
        {reviewText && <ReviewLine text={reviewText} ok={review?.ran === true && review.items.every((i) => verdictKind(i) === "verified")} />}
        <ProblemList plan={plan} issues={issues} watch={watch} narrated={narrated} review={review} masks={masks} sample={sample} issueCosts={issueCosts} />
      </Section>

      {narrated && plan.saidVsSeen && plan.saidVsSeen.length > 0 && (
        <Section title={SAID_VS_SEEN_HEADING} id="said-vs-saw">
          <p className="mb-3 text-sm text-ink/80" data-testid="said-vs-saw-tally">{saidVsSeenTally(plan.saidVsSeen)}</p>
          <SaidVsSeenList rows={plan.saidVsSeen} problemRanks={issues.map((x) => x.rank)} spaceName={plan.spaceName} sample={sample || !!example || plan.meta?.isExample === true} />
        </Section>
      )}

      <Section
        title={<>What&apos;s there{plan.inventory.length > 0 && <>{" "}<span className="ml-1 text-sm font-medium text-ink/70">approximate</span></>}</>}
        id="counts"
      >
        {plan.inventory.length === 0 && <Empty>Nothing was counted in this video.</Empty>}
        {/* Tiles grow to fill their row, so an odd last row (3 + 2, or 2 + 1 on phones) has no empty slot; four tiles stay 2 + 2. */}
        <ul className="flex flex-wrap gap-3 print:break-inside-avoid">
          {plan.inventory.map((item) => (
            <li key={item.label} className={`min-w-0 grow basis-[calc(50%-0.375rem)] rounded-2xl bg-white p-4 ${plan.inventory.length === 4 ? "" : "sm:basis-[calc(33.333%-0.5rem)]"}`}>
              <p className="text-3xl font-extrabold tabular-nums">{item.range ? range(item.range) : item.count}</p>
              <p className="font-medium break-words">{item.label}</p>
              {item.zone && !item.label.toLowerCase().includes(item.zone.toLowerCase()) && (
                <p className="text-sm text-ink/70">{item.zone}</p>
              )}
              {(() => {
                const note = countMethodNote(item, masks, sharedMethod);
                return note ? (
                  <p data-testid="count-method" className={`mt-1 text-xs ${note.low ? "font-semibold text-amber-900" : "text-ink/70"}`}>
                    {note.text}
                  </p>
                ) : null;
              })()}
            </li>
          ))}
        </ul>
        {plan.inventory.length > 0 && (
          <p data-testid="counts-footnote" className="mt-2 text-sm text-ink/70">{countsFootnote(masks, sharedMethod)}</p>
        )}
        <SendCountsButton inventory={plan.inventory} masks={masks} spaceName={plan.spaceName} sample={sample || !!example || plan.meta?.isExample === true} />
      </Section>

      <Section title="Do the work in this order" id="steps">
        {plan.workOrder.length === 0 && <Empty>{noStepsLine(issues.length)}</Empty>}
        {plan.workOrder.length > 0 && <WorkSteps plan={plan} stepCosts={stepCosts} problemRanks={new Set(issues.map((i) => i.rank))} />}
      </Section>

      {/* Materials and cost sit side by side on desktop (lg+) whenever a cost card renders; phones and tablets stack them. */}
      <div className={plan.costRange || plan.materials.length > 0 ? "lg:grid lg:grid-cols-2 lg:items-start lg:gap-8" : undefined}>
        <Section title="Materials" id="materials">
          {plan.materials.length === 0 && <Empty>No materials needed.</Empty>}
          {plan.materials.length > 0 && <MaterialsList plan={plan} sample={sample} problemRanks={new Set(issues.map((i) => i.rank))} />}
        </Section>

        {!plan.costRange && plan.materials.length > 0 && (
          <Section title="What it might cost">
            <Empty>
              {noStepsCost
                ? noStepsCost
                : plan.meta?.skipped?.cost || (location && !sample)
                ? `The cost range couldn\u2019t be worked out this run. The materials and work steps above are complete; try again to price them for ${location ?? "your area"}.`
                : sample
                  ? "This sample has no cost range. On a real run with a city or region, SightWork prices the materials and labor for that area."
                  : "This run didn\u2019t include a city and state, so there\u2019s no cost range. New runs ask for them before the plan is made."}
            </Empty>
          </Section>
        )}

        {plan.costRange && (
          <Section title={<>Cost range for <span data-testid="cost-region">{plan.costRange.region}</span></>} id="cost">
            <div className="rounded-2xl bg-white p-4">
              <p className="text-3xl font-extrabold tabular-nums">
                <span className="whitespace-nowrap">{usd(plan.costRange.low)}</span> –{" "}
                <span className="whitespace-nowrap">{usd(plan.costRange.high)}</span>
              </p>
              <p className="mt-1 text-sm text-ink/70">{plan.costRange.label}</p>
              <LivePrices costRange={plan.costRange} />
              {(issueCosts || stepCosts) && (
                <p className="mt-2 text-sm text-ink/70" data-testid="cost-shares-note">
                  {issueCosts && stepCosts
                    ? "Split by problem and by step above. Each list adds up to this total."
                    : issueCosts
                      ? "Split by problem above. The shares add up to this total."
                      : "Split by step above. The step costs add up to this total."}
                </p>
              )}
              {stepCosts && <CostLeft plan={plan} stepCosts={stepCosts} />}
              {stepCosts && <BudgetFit plan={plan} stepCosts={stepCosts} />}
              <details className="group mt-3 border-t border-ink/10 pt-3">
                <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-sm text-sm font-semibold text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent [&::-webkit-details-marker]:hidden">
                  <svg aria-hidden="true" viewBox="0 0 20 20" className="h-4 w-4 shrink-0 text-ink/60 motion-safe:transition-transform group-open:rotate-90">
                    <path d="M7 4l6 6-6 6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  How we got this
                </summary>
                <p className="mt-2 text-sm">
                  Region: {plan.costRange.region} · Labor: {plan.costRange.laborBasis}
                </p>
                <AreaIndex region={plan.costRange.region} />
                <ul className="mt-2 list-disc pl-5 text-sm text-ink/70">
                  {plan.costRange.assumptions.map((a) => (
                    <li key={a}>{a}</li>
                  ))}
                </ul>
                {plan.costRange.sources && plan.costRange.sources.length > 0 && (
                  <p className="mt-3 text-sm text-ink/70">
                    Prices from{" "}
                    {plan.costRange.sources.map((src, i) => (
                      <span key={src.url}>
                        {i > 0 && ", "}
                        <a
                          href={src.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="break-words rounded-sm underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                        >
                          {src.title}
                          <span className="sr-only"> (opens in a new tab)</span>
                        </a>
                      </span>
                    ))}
                  </p>
                )}
              </details>
              <SendCostButton plan={plan} sample={sample || !!example || plan.meta?.isExample === true} />
            </div>
          </Section>
        )}
      </div>

      {/* The after-picture placeholder is screen-only: a saved PDF shows just the finished plan.
          When the after-image step was skipped this run, no slot at all: "Powered by Meta" already says it was off. */}
      {!plan.afterImageUrl && !plan.meta?.skipped?.afterImage && plan.workOrder.length > 0 && (
        <Section title="After the work" className="print:hidden">
          <AfterSlot frame={slotFrame} sample={sample} />
        </Section>
      )}

      <PoweredByMeta plan={plan} sample={sample} />
    </article>
  );
}

/** Top-of-plan label for an example: green "Real run" for a real pipeline result, amber "Sample" for a hand-written one. */
function ExampleBanner({ example, videoName, onMakeYourOwn }: { example: Example; videoName: string | null; onMakeYourOwn?: () => void }) {
  const real = example.kind === "real";
  return (
    <div
      className={`mb-4 flex flex-col gap-3 rounded-xl px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between print:block ${
        real ? "bg-emerald-50 text-emerald-950 ring-1 ring-emerald-700/20" : "bg-amber-100 text-amber-900"
      }`}
    >
      <p>
        <span
          className={`mr-2 inline-block rounded-full px-2 py-0.5 text-xs font-bold uppercase tracking-wide text-white ${
            real ? "bg-safe-dark" : "bg-amber-800"
          }`}
        >
          {real ? "Real run" : "Sample"}
        </span>
        {videoName && (
          <>
            <strong>Example shown in place of your plan.</strong> Real analysis isn&apos;t on in this preview, so your video
            &ldquo;{videoName}&rdquo; was not sent anywhere.{" "}
          </>
        )}
        {example.banner}
        {example.credit && (
          <>
            {" "}
            Photo:{" "}
            <a href={example.credit.url} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">
              {example.credit.author}
            </a>
            , {example.credit.license}.
          </>
        )}
      </p>
      {onMakeYourOwn && (
        <button type="button" onClick={onMakeYourOwn} className="btn-primary shrink-0 self-start text-sm sm:self-auto print:hidden">
          Make your own
        </button>
      )}
    </div>
  );
}

/**
 * PROTOTYPE: how the priced state compares with the US average (src/lib/regionalCost.ts), shown under
 * "How we got this" so a tester can sanity-check the range. Labeled as an estimate; nothing is recomputed.
 */
function AreaIndex({ region }: { region: string }) {
  const state = stateFromRegion(region);
  const f = state ? regionalFactors(state) : null;
  if (!f) return null;
  return (
    <p className="mt-2 text-sm text-ink/70" data-testid="area-index">
      Area check: {describeFactors(f)} <span className="text-ink/60">({COST_INDEX_LABEL}; {COST_INDEX_SOURCE}.)</span>
    </p>
  );
}

/** One line under the cost range: how many material prices came from a live web search for this place. */
function LivePrices({ costRange }: { costRange: { pricing?: unknown; region?: unknown } }) {
  const text = livePricesLine(costRange);
  if (!text) return null;
  return (
    <p className="mt-2 flex items-start gap-2 text-sm text-ink" data-testid="cost-live-prices">
      <svg aria-hidden="true" viewBox="0 0 20 20" className="mt-0.5 h-4 w-4 shrink-0 text-accent">
        <circle cx="9" cy="9" r="5.5" fill="none" stroke="currentColor" strokeWidth="2" />
        <path d="M13 13l4 4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
      <span>{text}</span>
    </p>
  );
}
