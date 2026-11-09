"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { currentOwnVideoRunnerKind, needsTesterCode, pickRunnerKind, type RunnerKind } from "@/lib/client/selectRunner";
import { hasLastPlan } from "@/lib/client/lastPlan";
import { EXAMPLES, type Example } from "@/lib/examples";
import { loadTestCode, saveTestCode } from "@/lib/client/testCode";
import { checkLocation, CITY_MAX, isUsStateCode, isValidCity, loadLocation, saveLocation, US_STATES, type RunLocation } from "@/lib/client/location";
import { aimRange, aimRangeSpoken, checkDuration, DEFAULT_ROOM_SIZE, durationRulesFor, formatDuration, shortLength, type Check, type RoomSize } from "@/lib/client/duration";
import { loadRoomSize, saveRoomSize } from "@/lib/client/roomSize";
import { resolveVideoDuration } from "@/lib/client/videoDuration";
import { lightMessage, lightVerdict, type LightVerdict } from "@/lib/client/lightCheck";
import { sidewaysTip } from "@/lib/client/takeOrientation";
import { sampleVideoLuma } from "@/lib/client/sampleVideoLuma";
import { interruptedTakeNote } from "@/lib/client/recorder";
import { CameraRecorder, canRecordInPage, type RecordingInfo } from "./CameraRecorder";
import { SpacePicker } from "./SpacePicker";
import { RoomSizePicker } from "./RoomSizePicker";
import { stoppedRunNote } from "@/lib/client/stopRun";
import { listSavedTakes, listSavedTakesOnServer, savedTakeFor, subscribeSavedTakes } from "@/lib/client/savedTakes";
import { keptTakeNote } from "@/lib/client/saveVideo";
import { prefersShareSheet } from "@/lib/client/savePlanPdf";
import { SaveVideoButton } from "./SaveVideoButton";
import { SavedTakes } from "./SavedTakes";
import type { SavedPlan } from "@/lib/client/lastPlan";

/** Browsers leave `type` empty for some .mov files, so fall back to the extension. */
function isVideoFile(f: File): boolean {
  return f.type.startsWith("video/") || /\.(mp4|mov|m4v|webm|3gp)$/i.test(f.name);
}

// Whether a finished plan is saved on this device. The server render and the first client render
// both say no, so there's no hydration mismatch; another tab saving or clearing one updates it.
const subscribeStorage = (onChange: () => void) => {
  window.addEventListener("storage", onChange);
  return () => window.removeEventListener("storage", onChange);
};
const hasSavedPlan = hasLastPlan;
const noPlanOnServer = () => false;

export function UploadStep({
  onVideo,
  onExample,
  onLastPlan,
  recent,
  onOpenPlan,
  resumeFile,
  stoppedFile,
}: {
  /** Starts the run. `runner` is chosen here, once per video (see ownVideoRunnerKind). */
  onVideo: (file: File, runner: RunnerKind) => void;
  /** A video to show again with the tester-code prompt open (the server refused the code). */
  resumeFile?: File;
  /** A video whose run was stopped on the processing screen: shown again, ready to start, with a short note. */
  stoppedFile?: File;
  /** Opens an example plan by id (the featured real run when omitted). */
  onExample: (id?: string) => void;
  /** Reopens the last finished plan on this device; the link only shows when one is saved. */
  onLastPlan?: () => void;
  /** The "Your recent plans" list, shown under "Open my last plan". */
  recent?: React.ReactNode;
  /** Opens a saved plan; lets a saved take that already made a plan open it. */
  onOpenPlan?: (saved: SavedPlan) => void;
}) {
  const savedPlan = useSyncExternalStore(subscribeStorage, hasSavedPlan, noPlanOnServer);
  const takes = useSyncExternalStore(subscribeSavedTakes, listSavedTakes, listSavedTakesOnServer);
  // Two hidden pickers: "Choose a video" (library/files, no capture attribute) and the phone's own
  // camera app (capture="environment"), used when the in-page camera can't open.
  const input = useRef<HTMLInputElement>(null);
  const captureInput = useRef<HTMLInputElement>(null);
  const [recording, setRecording] = useState(false);
  const [recorded, setRecorded] = useState<RecordingInfo | null>(null);
  const [cameraNote, setCameraNote] = useState<string | null>(null);
  const [stoppedNote, setStoppedNote] = useState<string | null>(null);
  // The picker button unmounts once a video is chosen, so move focus to the preview card
  // instead of letting keyboard and screen-reader users fall back to the top of the page.
  const card = useRef<HTMLDivElement>(null);
  const [preview, setPreview] = useState<{ url: string; file: File } | null>(null);
  // The picked video's length as read, and the room size; the length check comes from both (duration.ts),
  // so changing the size on the video card re-checks the same video.
  const [len, setLen] = useState<{ state: "reading" } | { state: "known"; sec: number } | { state: "unplayable" }>({ state: "reading" });
  const [roomSize, setRoomSize] = useState<RoomSize>(DEFAULT_ROOM_SIZE);
  useEffect(() => setRoomSize(loadRoomSize()), []);
  const changeRoomSize = (size: RoomSize) => {
    setRoomSize(size);
    saveRoomSize(size);
  };
  const rules = durationRulesFor(roomSize);
  const check: Check =
    len.state === "reading"
      ? { kind: "reading" }
      : len.state === "unplayable"
        ? { kind: "block", message: "This browser can't play that video. Try an MP4, or record it again here." }
        : checkDuration(len.sec, roomSize);
  // Read in an effect so the server render and the first client render match.
  const [runner, setRunner] = useState<RunnerKind>("mock");
  // Where the user's own video goes: a real run, unless an example-plan preview was asked for on purpose.
  const [videoRunner, setVideoRunner] = useState<RunnerKind>("api");
  useEffect(() => {
    setRunner(pickRunnerKind(window.location.search, process.env.NEXT_PUBLIC_SIGHTWORK_RUNNER));
    setVideoRunner(currentOwnVideoRunnerKind());
  }, []);
  // The tester-code prompt on the video card: shown when a real run is asked for without a saved code.
  const [askCode, setAskCode] = useState(false);
  // City and state, required before a real run (the cost step prices for them), kept on this device.
  const [loc, setLoc] = useState<RunLocation>({ city: "", state: "" });
  const [locError, setLocError] = useState<string | null>(null);
  const cityField = useRef<HTMLInputElement>(null);
  const stateField = useRef<HTMLSelectElement>(null);
  useEffect(() => setLoc(loadLocation()), []);
  const changeLoc = (next: RunLocation) => {
    setLoc(next);
    saveLocation(next);
    if (locError && checkLocation(next).ok) setLocError(null);
  };
  /** Shows the inline message and moves focus to the first missing field. True when both are filled. */
  const locationReady = (): boolean => {
    const c = checkLocation(loc);
    if (c.ok) {
      setLocError(null);
      return true;
    }
    setLocError(c.message);
    (c.missing === "state" ? stateField : cityField).current?.focus();
    return false;
  };
  const send = (file: File) => {
    if (videoRunner === "api" && !locationReady()) return;
    if (needsTesterCode(videoRunner, loadTestCode())) setAskCode(true);
    else onVideo(file, videoRunner);
  };
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview.url); }, [preview]);
  const previewUrl = useRef<string | null>(null);
  useEffect(() => {
    previewUrl.current = preview?.url ?? null;
  }, [preview]);
  useEffect(() => { if (preview) card.current?.focus(); }, [preview]);

  const pick = useCallback((file: File, info: RecordingInfo | null = null) => {
    setDropError(false);
    setRecording(false);
    setCameraNote(null);
    setRecorded(info);
    setAskCode(false);
    setStoppedNote(null);
    setLen({ state: "reading" });
    setPreview({ url: URL.createObjectURL(file), file });
  }, []);
  // Back from a run the server refused for the tester code: the same video, with the code prompt open.
  useEffect(() => {
    if (!resumeFile) return;
    pick(resumeFile);
    // Stopped for the city and state: show that message (and the code prompt only if no code is saved).
    const where = checkLocation(loadLocation());
    if (where.ok) setAskCode(true);
    else {
      setLocError(where.message);
      setAskCode(!loadTestCode());
    }
  }, [resumeFile, pick]);
  // Back from a run stopped on the processing screen: the same video, ready to change details and start again.
  useEffect(() => {
    if (!stoppedFile) return;
    pick(stoppedFile);
    setStoppedNote(stoppedRunNote(stoppedFile.name));
  }, [stoppedFile, pick]);
  // Desktop: drop a video anywhere on the upload screen (dropping it outside a target used to make the
  // browser open the file in the tab and leave the app). The drop zone lights up while a file is dragged.
  const [dragging, setDragging] = useState(false);
  const [dropError, setDropError] = useState(false);
  useEffect(() => {
    if (preview || recording) return;
    let depth = 0;
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth += 1;
      setDragging(true);
    };
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragging(false);
    };
    const over = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault();
    };
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setDragging(false);
      const file = Array.from(e.dataTransfer?.files ?? []).find(isVideoFile);
      if (file) pick(file);
      else setDropError(true);
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragleave", leave);
    window.addEventListener("dragover", over);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("dragover", over);
      window.removeEventListener("drop", drop);
    };
  }, [preview, recording, pick]);

  // Record: the in-page camera when this browser has it, otherwise straight to the phone's camera app
  // (still inside the tap, so the browser allows opening the picker).
  // Back to the live camera from a take that stopped on its own; the old take is dropped.
  const recordAgain = () => {
    setPreview(null);
    setRecorded(null);
    setLen({ state: "reading" });
    startRecord();
  };
  const startRecord = () => {
    setCameraNote(null);
    if (canRecordInPage()) setRecording(true);
    else captureInput.current?.click();
  };

  const onFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Clear so picking the same file again still fires a change.
    e.target.value = "";
    if (!file) return;
    pick(file);
  };

  const durationSec = check.kind === "ok" || check.kind === "warn" ? check.durationSec : null;
  // A take that stopped on its own (page went to the background, camera turned off): say why and what was kept.
  const interruptedNote = recorded?.interruptedBy
    ? interruptedTakeNote(recorded.interruptedBy, len.state === "known" ? len.sec : recorded.durationSec, rules)
    : null;
  // Light check: once the length is known, measure a few frames on the device and warn (softly)
  // about a take too dark to show damage, before a real run spends anything on it.
  const [light, setLight] = useState<{ url: string; verdict: LightVerdict } | null>(null);
  const previewSrc = preview?.url ?? null;
  useEffect(() => {
    if (!previewSrc || durationSec === null) return;
    const ctl = new AbortController();
    void sampleVideoLuma(previewSrc, durationSec, ctl.signal)
      .then((stats) => {
        if (!ctl.signal.aborted) setLight({ url: previewSrc, verdict: lightVerdict(stats) });
      })
      .catch(() => {});
    return () => ctl.abort();
  }, [previewSrc, durationSec]);
  const lightNote = light && light.url === previewSrc && check.kind !== "block" ? lightMessage(light.verdict) : null;
  // Orientation tip: an upright take of a room that is not small loses the width of the room in every frame.
  const [shape, setShape] = useState<{ url: string; w: number; h: number } | null>(null);
  const orientationNote =
    shape && shape.url === previewSrc && check.kind !== "block" ? sidewaysTip(shape.w, shape.h, roomSize) : null;
  const canSend = check.kind === "ok" || check.kind === "warn";
  // Polite announcement for the length check; warnings and blocks have their own status/alert below.
  const liveText =
    check.kind === "reading" ? "Checking the video length." : check.kind === "ok" ? `Video is ${formatDuration(check.durationSec)} long. Ready to make your plan.` : "";

  return (
    <section>
      <h1 className="text-3xl font-extrabold leading-tight sm:text-4xl">Film a walkthrough. Get a work plan.</h1>
      <p className="mt-3 text-ink/70">
        Walk the space and say what needs work. Pick its size below for how long to film. SightWork counts what&apos;s there, finds the problems
        (including the ones you didn&apos;t mention), and lays out the work in order.
      </p>

      <input
        ref={input}
        type="file"
        accept="video/*"
        className="hidden"
        data-testid="choose-video-input"
        onChange={onFileInput}
      />
      <input
        ref={captureInput}
        type="file"
        accept="video/*"
        capture="environment"
        className="hidden"
        data-testid="camera-app-input"
        onChange={onFileInput}
      />

      {!preview ? (
        <>
          {recording ? (
            <CameraRecorder
              rules={rules}
              onRecorded={(file, info) => pick(file, info)}
              onCancel={() => setRecording(false)}
              onUnavailable={(message) => {
                setRecording(false);
                setCameraNote(message);
              }}
            />
          ) : (
            <>
            <RoomSizePicker value={roomSize} onChange={changeRoomSize} className="mt-6" />
            <div
              className={`mt-4 flex w-full flex-col items-center justify-center gap-3 rounded-2xl border-2 px-6 py-7 text-center transition-colors ${
                dragging ? "border-dashed border-accent-dark bg-accent/5" : "border-ink/20 bg-white"
              }`}
            >
              <CameraIcon />
              {dragging ? (
                <p className="text-base font-semibold text-accent-dark">Drop your video here</p>
              ) : null}
              <div className="flex w-full max-w-sm flex-col gap-2">
                <button type="button" onClick={startRecord} className="btn-primary w-full text-base motion-safe:active:scale-[.99]">
                  Record a walkthrough
                </button>
                <button
                  type="button"
                  onClick={() => input.current?.click()}
                  className="btn-secondary w-full text-base motion-safe:active:scale-[.99]"
                >
                  Choose a video
                </button>
              </div>
              <span className="text-sm text-ink/70">
                MP4 or MOV, {aimRange(rules)} (up to {shortLength(rules.hardMaxSec)})<span className="hidden [@media(pointer:fine)]:inline">. Or drag it here.</span>
              </span>
              <p className="text-xs text-ink/65">For the sharpest video, record in your Camera app and choose it here.</p>
            </div>
            </>
          )}
          {cameraNote && (
            <div role="alert" className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
              <p>{cameraNote}</p>
              <p className="mt-1 flex flex-wrap gap-x-4">
                <button type="button" onClick={() => captureInput.current?.click()} className="btn-tertiary text-sm">
                  Open the camera app
                </button>
                <button type="button" onClick={() => input.current?.click()} className="btn-tertiary text-sm">
                  Choose a video
                </button>
              </p>
            </div>
          )}
          {dropError && (
            <p role="alert" className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">
              That file isn&apos;t a video. Drop an MP4 or MOV walkthrough.
            </p>
          )}
          {savedPlan && onLastPlan ? (
            <p className="mt-2 text-center text-base">
              <button
                type="button"
                onClick={onLastPlan}
                className="btn-tertiary"
              >
                Open my last plan
              </button>
            </p>
          ) : null}
          {recent}
          <SavedTakes onUse={(file) => pick(file)} onOpenPlan={onOpenPlan} roomSize={roomSize} />
          {runner === "api" && <TesterCode />}
          <FilmingTips aim={aimRangeSpoken(rules)} label={rules.label} />
          <ExamplePicker onPick={onExample} />
        </>
      ) : (
        <div
          ref={card}
          tabIndex={-1}
          role="group"
          aria-label="Your walkthrough"
          className="mt-8 overflow-hidden rounded-2xl bg-white shadow-sm focus:outline-none"
        >
          <p aria-live="polite" className="sr-only">{liveText}</p>
          {stoppedNote && (
            <p role="status" data-testid="stopped-run-note" className="border-b border-ink/10 bg-ink/[.04] px-4 py-3 text-sm font-medium text-ink/80 break-words">
              {stoppedNote}
            </p>
          )}
          {/* Phone walkthroughs are usually portrait: cap the height and letterbox instead of forcing 16:9. */}
          <video
            key={preview.url}
            src={preview.url}
            controls
            playsInline
            preload="metadata"
            className="max-h-[60vh] w-full bg-black object-contain [@media(min-width:640px)_and_(max-height:820px)]:max-h-[38vh]"
            onLoadedMetadata={(e) => {
              const url = preview.url;
              setShape({ url, w: e.currentTarget.videoWidth, h: e.currentTarget.videoHeight });
              // In-page recordings (WebM) report an unknown length until scanned; work it out first.
              void resolveVideoDuration(e.currentTarget).then((d) => {
                if (previewUrl.current === url) setLen({ state: "known", sec: d });
              });
            }}
            onError={() => setLen({ state: "unplayable" })}
          />
          <div className="flex items-center justify-between gap-3 p-4">
            <p className="min-w-0 truncate text-sm text-ink/70">
              {preview.file.name}
              {durationSec !== null && <span className="text-ink/65"> · {formatDuration(durationSec)}</span>}
              {recorded?.resolution ? (
                <span className="block text-xs text-ink/65" data-testid="recorded-at">
                  Recorded here at {recorded.resolution}
                </span>
              ) : null}
            </p>
            <button
              type="button"
              onClick={() => input.current?.click()}
              aria-label="Change video"
              className="btn-tertiary -my-2 shrink-0 text-sm"
            >
              Change
            </button>
          </div>
          {recorded && (
            <div data-testid="save-take" className="mx-4 mb-3 rounded-lg bg-ink/[.04] px-3 py-2 print:hidden">
              <p className="text-sm text-ink/80">{keptTakeNote(Boolean(savedTakeFor(takes, preview.file)), prefersShareSheet())}</p>
              <div className="mt-2">
                <SaveVideoButton getFile={() => preview.file} />
              </div>
            </div>
          )}
          {interruptedNote && (
            <div role="status" data-testid="take-interrupted" className="mx-4 mb-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
              <p>{interruptedNote}</p>
              <button type="button" onClick={recordAgain} className="btn-secondary mt-2 w-full text-sm sm:w-auto">
                Record again
              </button>
            </div>
          )}
          {(check.kind === "warn" || check.kind === "block") && (
            <p
              role={check.kind === "block" ? "alert" : "status"}
              className={`mx-4 mb-3 rounded-lg px-3 py-2 text-sm ${
                check.kind === "block" ? "bg-red-50 text-red-800" : "bg-amber-50 text-amber-900"
              }`}
            >
              {check.message}
            </p>
          )}
          {lightNote && (
            <p role="status" data-testid="light-warning" className="mx-4 mb-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
              {lightNote}
            </p>
          )}
          {orientationNote && (
            <p role="status" data-testid="orientation-tip" className="mx-4 mb-3 rounded-lg bg-ink/[.04] px-3 py-2 text-sm text-ink/80">
              {orientationNote}
            </p>
          )}
          <div className="px-4 pb-4">
            {videoRunner === "api" && (
              <LocationFields
                value={loc}
                onChange={changeLoc}
                error={locError}
                cityRef={cityField}
                stateRef={stateField}
              />
            )}
            <SpacePicker />
            <RoomSizePicker value={roomSize} onChange={changeRoomSize} className="mb-3" />
            <button
              type="button"
              disabled={!canSend}
              onClick={() => send(preview.file)}
              className="btn-primary w-full text-lg motion-safe:active:scale-[.99]"
            >
              {check.kind === "reading" ? "Checking video…" : "Make my work plan"}
            </button>
            <p className="mt-2 text-center text-sm text-ink/70">
              {videoRunner === "api"
                ? "Frames and narration are sent to make your plan. The full video stays on this device."
                : "Preview build: your video stays on this device and an example plan is shown."}
            </p>
            {askCode && (
              <div role="alert" className="mt-3 rounded-xl bg-amber-50 p-3 text-amber-950">
                <p className="text-sm font-semibold">Enter the tester code to make a plan from this video.</p>
                <p className="mt-0.5 text-sm">Your video is kept here, and the plan runs on it as soon as the code is saved.</p>
                <TesterCode
                  autoFocus
                  submitLabel="Save and make my plan"
                  onSaved={() => {
                    if (!locationReady()) return;
                    setAskCode(false);
                    onVideo(preview.file, "api");
                  }}
                />
              </div>
            )}
          </div>
        </div>
      )}

      {preview ? (
        <button
          type="button"
          onClick={() => onExample()}
          className="btn-tertiary mt-4 w-full text-sm"
        >
          See an example plan first
        </button>
      ) : null}
    </section>
  );
}

/**
 * "How to film": what makes a walkthrough read well, shown before a video is picked. Based on capture
 * guidance for walkthrough scanning and video inspection apps (slow, steady, well lit, each area once,
 * name the area, say the problems). Wording stays general so it fits any kind of space.
 */
export const FILMING_TIPS: { icon: TipIcon; title: string; detail: string }[] = [
  { icon: "walk", title: "Walk slowly", detail: "About 1 to 2 feet a second, phone steady in both hands." },
  { icon: "light", title: "Lights on", detail: "Turn on the lights and open the blinds. Dark corners hide damage." },
  { icon: "distance", title: "Stay 3 to 6 feet from walls", detail: "Close enough for detail, far enough to fit whole items." },
  { icon: "once", title: "Cover each area once", detail: "One pass per area, so items aren\u2019t counted twice." },
  { icon: "pin", title: "Name each area", detail: "Say it as you walk in, like \u201cnow the hallway.\u201d" },
  { icon: "speak", title: "Point out problems", detail: "Say what needs work. SightWork also looks for what you don\u2019t mention." },
];

function FilmingTips({ aim, label }: { aim: string; label: string }) {
  return (
    <section aria-labelledby="film-tips-heading" className="mt-6 rounded-2xl bg-white/70 p-4 ring-1 ring-ink/10 sm:p-5">
      <h2 id="film-tips-heading" className="text-lg font-extrabold">
        How to film
      </h2>
      <p className="mt-0.5 text-sm text-ink/70">One steady take, about {aim} for a {label.toLowerCase()} space. Talking is optional, but it helps.</p>
      <ul className="mt-3 grid grid-cols-1 gap-x-5 gap-y-2.5 sm:gap-y-3 sm:grid-cols-2">
        {FILMING_TIPS.map((t) => (
          <li key={t.title} className="flex gap-3">
            <span
              aria-hidden
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent/10 text-accent-dark"
            >
              <TipGlyph icon={t.icon} />
            </span>
            <p className="min-w-0 text-sm leading-snug text-ink/70">
              <span className="font-semibold text-ink sm:block">
                {t.title}
                <span className="sm:hidden">.</span>
              </span>{" "}
              {t.detail}
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}

type TipIcon = "walk" | "light" | "distance" | "once" | "pin" | "speak";

/** Small outline glyphs for the filming tips (decorative; the text carries the meaning). */
function TipGlyph({ icon }: { icon: TipIcon }) {
  const paths: Record<TipIcon, React.ReactNode> = {
    walk: (
      <>
        <circle cx="13" cy="4.5" r="1.75" />
        <path d="m9 21 2.5-6.5L14 17v4M7.5 12l2.5-4.5 3.5 1 2 3.5 2.5 1M11.5 14.5 13 9" />
      </>
    ),
    light: (
      <>
        <path d="M9 18h6M10 21h4" />
        <path d="M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3Z" />
      </>
    ),
    distance: (
      <>
        <path d="M3 4v16M21 4v16" />
        <path d="M7 12h10M9.5 9.5 7 12l2.5 2.5M14.5 9.5 17 12l-2.5 2.5" />
      </>
    ),
    once: (
      <>
        <path d="M4 17c3-8 9-11 16-10" />
        <path d="m16.5 4 3.5 3-3.5 3.5" />
      </>
    ),
    pin: (
      <>
        <path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0C18.5 15.4 12 21 12 21Z" />
        <circle cx="12" cy="10" r="2.25" />
      </>
    ),
    speak: (
      <>
        <path d="M5 5h14a1.5 1.5 0 0 1 1.5 1.5v8A1.5 1.5 0 0 1 19 16h-8l-4.5 3.5V16H5a1.5 1.5 0 0 1-1.5-1.5v-8A1.5 1.5 0 0 1 5 5Z" />
        <path d="M12 8v3.5M12 13.5v.01" />
      </>
    ),
  };
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-[18px] w-[18px]"
    >
      {paths[icon]}
    </svg>
  );
}

/** Simple outline video camera, drawn in SVG so it renders the same on every phone. */
function CameraIcon() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-10 w-10 text-ink/70"
    >
      <rect x="2.5" y="6" width="13" height="12" rx="2.5" />
      <path d="M15.5 10.5 21 7.5v9l-5.5-3" />
    </svg>
  );
}

/**
 * Example plans before filming: the real SightWork run (sanctuary stage) as the wide card, so the first plan a visitor opens is a
 * real result, then the hand-written samples for other kinds of spaces. Each card says "Real run" or "Sample" so nothing reads as a model result
 * that wasn't one.
 */
function ExamplePicker({ onPick }: { onPick: (id: string) => void }) {
  const featured = EXAMPLES.find((e) => e.kind === "real") ?? EXAMPLES[0];
  const samples = EXAMPLES.filter((e) => e !== featured);
  return (
    <section aria-labelledby="examples-heading" className="mt-8">
      <h2 id="examples-heading" className="text-lg font-extrabold">
        See a plan first
      </h2>
      <p className="mt-1 text-sm text-ink/70">One real SightWork run, plus samples on real photos of other spaces.</p>
      <ExampleCard example={featured} onPick={onPick} wide />
      <ul className="mt-3 grid grid-cols-1 gap-x-3 sm:grid-cols-2">
        {samples.map((e) => (
          <li key={e.id}>
            <ExampleCard example={e} onPick={onPick} />
          </li>
        ))}
      </ul>
      <p className="mt-2 text-xs text-ink/60">
        Sample photos are CC0 (free to use), via Wikimedia Commons.{" "}
        <a href="/credits" className="inline-block py-1 underline underline-offset-2">
          Credits
        </a>
      </p>
    </section>
  );
}

function ExampleCard({ example, onPick, wide = false }: { example: Example; onPick: (id: string) => void; wide?: boolean }) {
  const real = example.kind === "real";
  return (
    <button
      type="button"
      onClick={() => onPick(example.id)}
      className={`group mt-3 flex w-full overflow-hidden rounded-2xl bg-white text-left shadow-sm ring-1 ring-ink/10 transition hover:ring-ink/30 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent motion-safe:active:scale-[.99] ${
        wide ? "flex-col sm:flex-row" : "flex-row sm:flex-col"
      }`}
    >
      <span className={`relative block shrink-0 bg-ink ${wide ? "aspect-video w-full sm:w-1/2" : "w-28 sm:aspect-[4/3] sm:w-full"}`}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={example.thumb}
          alt=""
          loading={wide ? "eager" : "lazy"}
          fetchPriority={wide ? "high" : undefined}
          decoding="async"
          className="absolute inset-0 h-full w-full object-cover"
        />
        <span
          className={`absolute left-2 top-2 rounded-full px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide text-white ${
            real ? "bg-safe-dark" : "bg-ink/80"
          }`}
        >
          {real ? "Real run" : "Sample"}
        </span>
      </span>
      <span className={`flex min-w-0 flex-col justify-center gap-1 ${wide ? "p-4 sm:p-5" : "p-3"}`}>
        <span className={`font-bold leading-snug ${wide ? "text-lg" : "text-base"}`}>{example.title}</span>
        <span className="text-sm text-ink/70">{example.blurb}</span>
        <span className="mt-1 text-sm font-semibold text-accent-dark group-hover:underline">
          Open plan <span aria-hidden>→</span>
        </span>
      </span>
    </button>
  );
}

/**
 * The tester code, typed once and kept on this device. Shown on the upload screen in real-run mode
 * (`?runner=api`), and on the video card when a real run is asked for without one (`onSaved` then starts it).
 */
function TesterCode({
  autoFocus = false,
  submitLabel = "Save",
  onSaved,
}: { autoFocus?: boolean; submitLabel?: string; onSaved?: () => void } = {}) {
  const [code, setCode] = useState("");
  const [saved, setSaved] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const c = loadTestCode();
    setCode(c);
    setSaved(Boolean(c));
    if (autoFocus) field.current?.focus();
  }, [autoFocus]);
  return (
    <form
      className={onSaved ? "mt-3" : "mt-4 rounded-xl bg-white/70 p-3"}
      onSubmit={(e) => {
        e.preventDefault();
        saveTestCode(code);
        const ok = Boolean(code.trim());
        setSaved(ok);
        if (ok) onSaved?.();
      }}
    >
      <label htmlFor={onSaved ? "tester-code-run" : "tester-code"} className="block text-sm font-semibold">
        Tester code for real runs
      </label>
      <div className="mt-2 flex gap-2">
        <input
          ref={field}
          id={onSaved ? "tester-code-run" : "tester-code"}
          type="password"
          autoComplete="off"
          value={code}
          onChange={(e) => {
            setCode(e.target.value);
            setSaved(false);
          }}
          className="min-h-11 min-w-0 flex-1 rounded-lg border border-ink/20 bg-white px-3 text-base"
        />
        <button type="submit" className={`${onSaved ? "btn-primary" : "btn-secondary"} shrink-0 text-sm`}>
          {submitLabel}
        </button>
      </div>
      <p aria-live="polite" className="mt-1 text-xs text-ink/70">
        {saved ? "Saved on this device." : "Real runs use paid model credits, so they need a code."}
      </p>
    </form>
  );
}

/**
 * City and state for a real run, on the video card above "Make my work plan". Both are required: the
 * cost step prices materials and labor for that area, and the plan says which area it priced for.
 * Saved on this device as they're typed (src/lib/client/location.ts), so testers don't retype them.
 */
function LocationFields({
  value,
  onChange,
  error,
  cityRef,
  stateRef,
}: {
  value: RunLocation;
  onChange: (next: RunLocation) => void;
  error: string | null;
  cityRef: React.RefObject<HTMLInputElement | null>;
  stateRef: React.RefObject<HTMLSelectElement | null>;
}) {
  const cityBad = Boolean(error) && !isValidCity(value.city);
  const stateBad = Boolean(error) && !isUsStateCode(value.state);
  return (
    <fieldset className="mb-3" data-testid="location-fields">
      <legend className="text-sm font-semibold">Where is this space?</legend>
      <p id="location-hint" className="mt-0.5 text-xs text-ink/70">
        Required for a real run. Used to price materials and labor for your area. Saved on this device.
      </p>
      <div className="mt-2 flex gap-2">
        <div className="min-w-0 flex-1">
          <label htmlFor="run-city" className="block text-xs font-medium text-ink/80">
            City
          </label>
          <input
            ref={cityRef}
            id="run-city"
            type="text"
            autoComplete="address-level2"
            maxLength={CITY_MAX}
            required
            aria-invalid={cityBad || undefined}
            aria-describedby={error ? "location-error location-hint" : "location-hint"}
            placeholder="e.g. Sebring"
            value={value.city}
            onChange={(e) => onChange({ ...value, city: e.target.value })}
            className={`mt-1 min-h-11 w-full rounded-lg border bg-white px-3 text-base ${cityBad ? "border-red-600" : "border-ink/20"}`}
          />
        </div>
        <div className="w-[9.5rem] shrink-0">
          <label htmlFor="run-state" className="block text-xs font-medium text-ink/80">
            State
          </label>
          <select
            ref={stateRef}
            id="run-state"
            autoComplete="address-level1"
            required
            aria-invalid={stateBad || undefined}
            aria-describedby={error ? "location-error location-hint" : "location-hint"}
            value={value.state}
            onChange={(e) => onChange({ ...value, state: e.target.value })}
            className={`mt-1 min-h-11 w-full rounded-lg border bg-white px-2 text-base ${stateBad ? "border-red-600" : "border-ink/20"}`}
          >
            <option value="">Choose…</option>
            {US_STATES.map((st) => (
              <option key={st.code} value={st.code}>
                {st.code} · {st.name}
              </option>
            ))}
          </select>
        </div>
      </div>
      {error && (
        <p id="location-error" role="alert" className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">
          {error}
        </p>
      )}
    </fieldset>
  );
}
