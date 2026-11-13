"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { RUN_STEPS, type PlanStep, type WorkPlan } from "@/lib/types";
import { EXAMPLES, findExample, type Example } from "@/lib/examples";
import { planJobFor, type RunnerKind } from "@/lib/client/selectRunner";
import { isPaidRefusal, isResumeFailure, isTesterCodeFailure, isTimeLimitFailure } from "@/lib/client/apiPlanJob";
import { loadRegion } from "@/lib/client/location";
import { usePlanJob } from "@/lib/client/usePlanJob";
import { loadLastPlanAsync, saveLastPlan } from "@/lib/client/lastPlan";
import { addRecentPlan } from "@/lib/client/recentPlans";
import { buzzPlanReady, cuePlanReady } from "@/lib/client/planReadyCue";
import { showPlanTitle } from "@/lib/client/planTitle";
import { RecentPlans } from "./RecentPlans";
import { AccessNavLinks } from "./AccessLinks";
import { UploadStep } from "./UploadStep";
import { ProcessingStep } from "./ProcessingStep";
import { PlanView } from "./PlanView";
import { SavePdfButton } from "./SavePdfButton";

type Stage =
  // `resume`: back from a run the server refused for a missing or wrong tester code; the same video is
  // shown again with the code prompt open.
  // `stopped`: the user stopped the run on the processing screen; the same video is shown again, ready to start.
  | { kind: "upload"; resume?: File; stopped?: File }
  // `light`: this try uses fewer, smaller frames, set when the run before it ran out of time.
  | { kind: "processing"; file: File; run: number; runner: RunnerKind; light?: boolean }
  | { kind: "plan"; plan: WorkPlan; videoName: string | null; example?: Example; savedAt?: string };

/** Nothing runs while there's no video; the runner is chosen per run (see UploadStep and ownVideoRunnerKind). */
const idleJob = planJobFor("mock");

/** `initialExampleId`: open on that example plan (prerendered example pages), instead of the upload screen. */
export function SightWorkFlow({ initialExampleId }: { initialExampleId?: string } = {}) {
  const [stage, setStage] = useState<Stage>(() => {
    if (!initialExampleId) return { kind: "upload" };
    const example = findExample(initialExampleId);
    return { kind: "plan", plan: example.plan, videoName: null, example };
  });
  // Set when a run finishes into a plan, so only that plan (not an example or a saved plan) gets the tab cue.
  const readyCue = useRef(false);
  const { status: job, checks } = usePlanJob(stage.kind === "processing" ? planJobFor(stage.runner, stage.light === true) : idleJob, stage.kind === "processing" ? stage.file : null, stage.kind === "processing" ? stage.run : 0);

  useEffect(() => {
    if (stage.kind === "processing" && job?.state === "done") {
      // The preview (mock) runner ends on an example plan: keep its Real run / Sample label.
      const example = EXAMPLES.find((e) => e.plan === job.plan);
      readyCue.current = true;
      setStage({ kind: "plan", plan: job.plan, videoName: stage.file.name, example });
      saveLastPlan(job.plan, stage.file.name);
      // Only real runs go on the recent list; a preview run that ends on an example plan doesn't.
      if (!example) void addRecentPlan(job.plan, stage.file.name);
    }
  }, [job, stage]);

  const showExample = (id?: string) => {
    const example = findExample(id);
    setStage({ kind: "plan", plan: example.plan, videoName: null, example });
  };
  // Falls back to staying on upload if the saved plan was cleared since the link showed.
  // A big real run is kept in IndexedDB, so this can take a moment.
  const showLastPlan = () => {
    void loadLastPlanAsync().then((saved) => {
      if (saved) setStage({ kind: "plan", plan: saved.plan, videoName: saved.videoName, savedAt: saved.savedAt });
    });
  };

  // `?view=example` opens straight on the example plan: a direct link for screen checks at
  // phone, tablet and desktop widths, and a one-tap fallback. On the server it's rewritten
  // to the prerendered /start/example/<id> page (initialExampleId); this client path is the fallback.
  // `?view=last` reopens the last finished plan on this device (falls back to the upload screen).
  useEffect(() => {
    const view = new URLSearchParams(window.location.search).get("view");
    // Prerendered example pages already start on the plan.
    if (view === "example" && !initialExampleId) showExample(new URLSearchParams(window.location.search).get("ex") ?? undefined);
    if (view === "last") {
      void loadLastPlanAsync().then((saved) => {
        if (saved) setStage({ kind: "plan", plan: saved.plan, videoName: saved.videoName, savedAt: saved.savedAt });
        else document.documentElement.classList.remove("sw-opening");
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // A real or saved plan names its space in the tab title; example pages keep their own title. Declared
  // before the plan-ready cue so the cue goes on top and comes back to this title.
  const titleSpace = stage.kind === "plan" && !stage.example ? stage.plan.spaceName : null;
  useEffect(() => {
    if (titleSpace === null) return;
    return showPlanTitle(titleSpace);
  }, [titleSpace]);
  // A plan that finished while the tab was in the background: the tab title says so until the tab is
  // shown again. This runs after the processing screen's own title cleanup, so the cue isn't overwritten.
  const planIssues = stage.kind === "plan" ? stage.plan.issues.length : null;
  useEffect(() => {
    if (stage.kind !== "plan" || !readyCue.current) return;
    readyCue.current = false;
    // On a phone that can vibrate, a short buzz says the plan is ready even with the screen in a pocket.
    buzzPlanReady();
    return cuePlanReady(planIssues);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage]);
  // The `?view=last` plan is on screen: show the app (app/start/page.tsx hid it to avoid an upload-screen flash).
  useEffect(() => {
    if (stage.kind === "plan") document.documentElement.classList.remove("sw-opening");
  }, [stage.kind]);
  // When the job finishes, show every step passed (not step 1) for the frame before the plan opens,
  // so the bar never snaps back to the start.
  const current = !job ? 0 : job.state === "done" ? RUN_STEPS.length : RUN_STEPS.indexOf(job.step);

  // Steps the server reported as skipped this run. The list is cumulative, so keep the latest one
  // through a failure (failed lines don't carry it); a new run starts empty.
  const [skipped, setSkipped] = useState<PlanStep[]>([]);
  const runKey = stage.kind === "processing" ? stage.run : 0;
  useEffect(() => setSkipped([]), [runKey]);
  useEffect(() => {
    if (job?.state === "running" && job.skipped?.length) setSkipped(job.skipped);
  }, [job]);

  // New stage: back to the top so the next screen starts at its heading, not mid-scroll, and move
  // keyboard and screen-reader focus to that heading (the button that was pressed is gone). "Try again"
  // keeps the processing stage but starts a new run, and its button unmounts too, so do the same then.
  // Compare against the last stage seen rather than a "first run" flag: React's dev Strict Mode runs
  // effects twice on mount, which used to focus (and ring) the upload heading on a fresh page load.
  const shownStage = useRef(`${stage.kind}:${runKey}`);
  useEffect(() => {
    const key = `${stage.kind}:${runKey}`;
    if (shownStage.current === key) return;
    shownStage.current = key;
    window.scrollTo({ top: 0 });
    const heading = document.querySelector<HTMLElement>("main h1");
    if (heading) {
      heading.tabIndex = -1;
      heading.focus({ preventScroll: true });
    }
  }, [stage.kind, runKey]);

  // Phones get the full width; tablets and desktops get a readable column, wider for the plan.
  const width =
    stage.kind === "plan"
      ? "max-w-xl md:max-w-2xl lg:max-w-3xl"
      : stage.kind === "processing"
        ? "max-w-xl md:max-w-2xl lg:max-w-4xl"
        : "max-w-xl md:max-w-2xl";
  const startOver = () => setStage({ kind: "upload" });

  return (
    <>
      {/* Opaque on purpose: a see-through header over the dark before/after picture dropped the orange "Work" below 3:1 (axe). */}
      <header className="sticky top-0 z-20 print:hidden border-b border-ink/10 bg-paper pt-[env(safe-area-inset-top)]">
        <div className={`mx-auto flex min-h-14 w-full flex-wrap items-center justify-between gap-x-3 gap-y-1 px-4 py-1 sm:px-6 ${width}`}>
          {/* The tagline sits beside the button, not in it, so the button's spoken name starts with the
              word you see ("SightWork"), as voice-control users expect. */}
          <div className="flex min-w-0 items-center gap-2">
            <button
              type="button"
              onClick={startOver}
              aria-label="SightWork, start a new walkthrough"
              className="-mx-2 flex min-h-11 items-center rounded-lg px-2 text-xl font-extrabold tracking-tight focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              Sight<span className="text-accent">Work</span>
            </button>
            {/* The upload screen's H1 already says this, and on the plan the header is full with Save PDF and
                New walkthrough, so the tagline only shows while processing (from lg, on one line). */}
            {stage.kind === "processing" && (
              <span className="hidden whitespace-nowrap text-sm font-medium tracking-normal text-ink/65 lg:inline">Film a walkthrough. Get a work plan.</span>
            )}
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            {/* Pricing and the own-key Settings, so a new visitor sees both ways to make plans. The plan header
                already holds Save PDF and New walkthrough, so there they give way (one row keeps the section chips clear). */}
            {stage.kind !== "plan" && <AccessNavLinks />}
            {/* Back to the landing's explainer. On phones the plan header already holds Save PDF and New, so it waits for sm there. */}
            <Link
              href="/#how-heading"
              className={`hidden sm:inline-flex min-h-11 items-center rounded-lg px-2 text-sm font-medium text-ink/70 underline-offset-4 hover:text-ink hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent`}
            >
              How it works
            </Link>
            {stage.kind === "plan" && (
              <>
                <SavePdfButton plan={stage.plan} example={stage.example} sample={stage.example?.kind === "sample" || (!stage.example && stage.plan.meta?.isExample === true)} />
                <button
                  type="button"
                  onClick={startOver}
                  className="min-h-11 shrink-0 rounded-full border border-ink/20 bg-white/60 px-4 text-sm font-medium hover:border-ink/40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                >
                  <span className="sm:hidden">New</span>
                  <span className="hidden sm:inline">New walkthrough</span>
                </button>
              </>
            )}
          </div>
        </div>
      </header>

      <main id="main-content" tabIndex={-1} className={`outline-none mx-auto w-full px-4 pb-[calc(4rem+env(safe-area-inset-bottom))] pt-6 sm:px-6 md:pt-10 ${width}`}>
      {stage.kind === "upload" && (
        <UploadStep
          onVideo={(file, runner) => setStage({ kind: "processing", file, run: 1, runner })}
          resumeFile={stage.resume}
          stoppedFile={stage.stopped}
          onExample={showExample}
          onLastPlan={showLastPlan}
          recent={<RecentPlans onOpen={(saved) => setStage({ kind: "plan", plan: saved.plan, videoName: saved.videoName, savedAt: saved.savedAt })} />}
          onOpenPlan={(saved) => setStage({ kind: "plan", plan: saved.plan, videoName: saved.videoName, savedAt: saved.savedAt })}
        />
      )}
      {stage.kind === "processing" && (
        <ProcessingStep
          steps={RUN_STEPS}
          current={current}
          videoName={stage.file.name}
          videoFile={stage.file}
          failure={job?.state === "failed" ? { message: job.message, costUsd: job.costUsd, costPartial: job.costPartial } : null}
          onRetry={() => setStage({ ...stage, run: stage.run + 1, light: stage.light || (stage.runner === "api" && job?.state === "failed" && isTimeLimitFailure(job.message)) })}
          lighterRetry={stage.runner === "api" && !stage.light && job?.state === "failed" && isTimeLimitFailure(job.message)}
          onEnterCode={
            stage.runner === "api" && job?.state === "failed" && isResumeFailure(job.message)
              ? () => setStage({ kind: "upload", resume: stage.file })
              : undefined
          }
          enterCodeLabel={
            job?.state === "failed"
              ? isPaidRefusal(job.message)
                ? "Use your own key or buy plans"
                : !isTesterCodeFailure(job.message)
                  ? "Add city and state"
                  : undefined
              : undefined
          }
          paidRefusal={job?.state === "failed" && isPaidRefusal(job.message)}
          onExample={() => showExample()}
          onStop={() => setStage({ kind: "upload", stopped: stage.file })}
          skipped={skipped}
          checks={checks}
          region={stage.runner === "api" ? loadRegion() : null}
          realRun={stage.runner === "api"}
          narrationPart={job?.state === "running" && job.step === "listening" ? (job.part ?? null) : null}
        />
      )}
      {stage.kind === "plan" && <PlanView plan={stage.plan} videoName={stage.videoName} example={stage.example} savedAt={stage.savedAt} onMakeYourOwn={startOver} />}
      </main>
    </>
  );
}
