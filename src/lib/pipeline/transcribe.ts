/**
 * SightWork pipeline step: `transcribe`.
 *
 * Turns the narration WAV from a PlanRequest into the transcript lines
 * the reason step reads (prompt 01
 * spec). When there is no audio, no call is made and the result is
 * empty: transcript null, transcriptTurns []. The reason step then
 * runs on frames alone with every issue unmentioned.
 *
 * This module makes no API calls and holds no keys. The ASR caller and
 * the optional Spark cleanup caller are injected by the wiring code
 * (later: src/lib/meta), so the step is testable on mock data and the
 * spike can swap callers without touching this logic. Every would-be
 * call is recorded on the usage tracker from ./usage.ts, so the $10
 * spike cap is enforced in code. A billed-but-failed ASR or cleanup
 * call is recorded the same way before rethrowing, so the route total
 * counts it even though runPlan continues without narration.
 *
 * ASR settings (prompt 01, enforced by the caller, not here):
 * - model muse-voice-transcribe-1.0; confirm the ID at the first spike
 * - WAV, mono, 16-bit PCM, 16 or 24 kHz; max 32 MB / 10 min
 * - diarization off (one speaker); Standard mode, never -contributor
 *   (contributor mode lets Meta train on the content; demo footage
 *   is not for training)
 *
 * Post-processing (all in the prompt file, enforced here, not trusted
 * to the model):
 * - drop empty turns; no turn with text means transcript null
 * - transcript is built from transcriptTurns, so the two never disagree
 * - cleanup is discarded if it changes the line count or any [t]
 *   prefix, and the raw turns are used instead
 */

import type { TranscriptTurn } from "../types";
import { recordFailedCall, type UsageTracker } from "./usage";

/** Model ID from prompt 01; confirm it at the first spike. */
export const TRANSCRIBE_MODEL = "muse-voice-transcribe-1.0";
export const CLEANUP_MODEL = "muse-spark";

/** Max audio size from prompt 01 (32 MB). */
export const MAX_AUDIO_BYTES = 32 * 1024 * 1024;

/** Default keyword bias from prompt 01 (demo-footage walkthrough terms). */
export const DEFAULT_KEYWORD_BIAS = [
  "exit sign",
  "egress",
  "riser",
  "platform",
  "baptistry",
  "pulpit",
  "choir loft",
  "truss",
  "ceiling tile",
  "water stain",
  "gaffer tape",
  "cable cover",
  "power strip",
  "extension cord",
  "fire extinguisher",
  "ADA",
  "ramp",
  "handrail",
  "sconce",
  "can light",
  "folding chair",
  "pew",
  "upholstery",
  "drywall",
  "baseboard",
  "sound booth",
  "monitor wedge",
  "subwoofer",
];

/** One ASR turn as the caller returns it (unknown shape, validated here). */
export interface RawTurn {
  startSec: number;
  endSec?: number;
  text: string;
}

/** A model call supplied by the wiring code. Never a real call in tests. */
export interface TranscribeCaller {
  (req: {
    model: string;
    /** Standard mode only; never contributor mode. */
    mode: "standard";
    audioWavBase64: string;
    keywordBias: string[];
    /**
     * Abort signal for a stopped run; the Meta ASR caller passes it
     * to its fetch, so a stopped run stops mid-transcription instead
     * of billing the whole ASR call. Omit it and the call runs as
     * before.
     */
    signal?: AbortSignal;
  }): Promise<{ turns: unknown; latencyMs: number; costUsd: number }>;
}

/** Optional Spark cleanup caller; omitted means no cleanup pass. */
export interface CleanupCaller {
  (req: {
    model: string;
    prompt: string;
    /**
     * Abort signal for a stopped run; the Spark cleanup caller
     * passes it to its fetch, same shape as the ASR caller's signal
     * above. Omit it and the call runs as before.
     */
    signal?: AbortSignal;
  }): Promise<{
    text: string;
    latencyMs: number;
    costUsd: number;
  }>;
}

export interface TranscribeInput {
  /** Base64 WAV (mono, 16-bit PCM, 16 or 24 kHz). Omit for no narration. */
  audioWavBase64?: string;
  spaceType?: string;
}

export interface TranscribeOutput {
  /** One line per turn: "[startSec] text", startSec to one decimal. */
  transcript: string | null;
  transcriptTurns: TranscriptTurn[];
}

export interface TranscribeDeps {
  callTranscribe: TranscribeCaller;
  tracker: UsageTracker;
  /**
   * Abort signal for a stopped run, forwarded to the ASR call and
   * the cleanup call below, matching the reason/cost/review legs.
   * Omit it and both calls run as before.
   */
  signal?: AbortSignal;
  keywordBias?: string[];
  /**
   * Cleanup prompt template with {{raw_turns}}, {{space_type}} and
   * {{keyword_bias}} placeholders. When set together with callCleanup,
   * the cleanup pass runs; otherwise raw turns are used as-is.
   */
  cleanupPrompt?: string;
  callCleanup?: CleanupCaller;
}

/**
 * Fail fast on a bad transcribe request before any paid call. An
 * empty audio string still means "no narration" (the skip path below),
 * so the audio checks run only on a non-empty string: valid base64,
 * WAV header, the 32 MB step cap, and the mono s16le 16/24 kHz
 * format Meta transcribe accepts (a WAV with no fmt chunk in the
 * decoded head passes, left to runTranscribe and the provider).
 */
export function validateTranscribeInput(input: TranscribeInput): void {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("transcribe: input is not an object");
  }
  if (
    input.audioWavBase64 !== undefined &&
    typeof input.audioWavBase64 !== "string"
  ) {
    throw new Error("transcribe: audioWavBase64 is not a string");
  }
  // Parity with the route validator (src/lib/pipeline/planRequest.ts)
  // and validateRunPlanRequest: an empty string means "not given"
  // (runTranscribe returns no transcript), but a spaces-only string
  // is truthy, so it rides past the no-audio skip into audioByteLength
  // and dies there with a misleading "not a WAV file" error (0 bytes
  // after stripping). A direct runTranscribe caller gets the same
  // fail-fast here instead of only via the route.
  if (
    typeof input.audioWavBase64 === "string" &&
    input.audioWavBase64.length > 0 &&
    input.audioWavBase64.trim().length === 0
  ) {
    throw new Error("transcribe: audioWavBase64 must not be blank when given");
  }
  // Parity with runTranscribe below and validateRunPlanRequest:
  // a non-empty audio string that is not valid base64, not a WAV,
  // over the 32 MB step cap, or in a format Meta transcribe refuses
  // used to pass this validator and only fail inside runTranscribe,
  // after validation — so the transcribe route answered 500 ("We
  // couldn't transcribe that narration") instead of 400 for
  // malformed audio, and a direct caller validating first got a
  // mid-run failure instead of a fail-fast one. The messages match
  // runTranscribe's, so a caller that validates first and a caller
  // that runs both see the same error. A WAV with no fmt chunk in
  // the decoded head passes, like the route validator, and is left
  // to runTranscribe and the provider.
  if (
    typeof input.audioWavBase64 === "string" &&
    input.audioWavBase64.length > 0
  ) {
    const bytes = audioByteLength(input.audioWavBase64);
    if (bytes > MAX_AUDIO_BYTES) {
      throw new Error(
        `transcribe: audio is ${bytes} bytes, over the ${MAX_AUDIO_BYTES} byte limit`,
      );
    }
    if (bytes < 12) {
      throw new Error("transcribe: audio is not a WAV file (missing RIFF/WAVE header)");
    }
    const head = Buffer.from(input.audioWavBase64, "base64").subarray(0, 12).toString("latin1");
    if (head.slice(0, 4) !== "RIFF" || head.slice(8, 12) !== "WAVE") {
      throw new Error("transcribe: audio is not a WAV file (missing RIFF/WAVE header)");
    }
    const fmtHead = Buffer.from(input.audioWavBase64.replace(/\s/g, "").slice(0, 268), "base64");
    let off = 12;
    while (off + 8 <= fmtHead.length) {
      const id = fmtHead.subarray(off, off + 4).toString("latin1");
      const size = fmtHead.readUInt32LE(off + 4);
      if (id === "fmt " && size >= 16 && off + 8 + 16 <= fmtHead.length) {
        const format = fmtHead.readUInt16LE(off + 8);
        const channels = fmtHead.readUInt16LE(off + 10);
        const sampleRate = fmtHead.readUInt32LE(off + 12);
        const bits = fmtHead.readUInt16LE(off + 22);
        if (
          format !== 1 ||
          channels !== 1 ||
          (sampleRate !== 16000 && sampleRate !== 24000) ||
          bits !== 16
        ) {
          throw new Error(
            `transcribe: audio must be mono s16le WAV at 16000 or 24000 Hz ` +
              `(got format ${format}, ${channels} channel(s), ${sampleRate} Hz, ${bits}-bit)`,
          );
        }
        break;
      }
      off += 8 + size + (size % 2);
    }
  }
  // Parity with the route validator (src/lib/pipeline/planRequest.ts)
  // and validateRunPlanRequest: an empty string means "not given"
  // (the cleanup fill below already defaults an empty spaceType to
  // "room"), so only a non-string or a spaces-only string fails here.
  // A plan request with narration and spaceType "" used to pass both
  // route validators and then fail at "listening" inside runTranscribe.
  if (
    input.spaceType !== undefined &&
    (typeof input.spaceType !== "string" ||
      (input.spaceType.length > 0 && input.spaceType.trim().length === 0))
  ) {
    throw new Error("transcribe: spaceType is not a non-empty string");
  }
}

/**
 * Fail fast on bad wiring before any paid call. A bad tracker used to
 * throw only after the paid ASR call, when record ran; a bad
 * keywordBias used to ride into that call unchecked.
 */
export function validateTranscribeDeps(deps: TranscribeDeps): void {
  if (deps === null || typeof deps !== "object" || Array.isArray(deps)) {
    throw new Error("transcribe: deps is not an object");
  }
  if (typeof deps.callTranscribe !== "function") {
    throw new Error("transcribe: callTranscribe is not a function");
  }
  if (
    deps.tracker === null ||
    typeof deps.tracker !== "object" ||
    typeof deps.tracker.record !== "function"
  ) {
    throw new Error("transcribe: tracker.record is not a function");
  }
  if (deps.keywordBias !== undefined) {
    if (
      !Array.isArray(deps.keywordBias) ||
      deps.keywordBias.some((k) => typeof k !== "string" || !k.trim())
    ) {
      throw new Error("transcribe: keywordBias is not an array of non-empty strings");
    }
  }
  if (
    deps.cleanupPrompt !== undefined &&
    (typeof deps.cleanupPrompt !== "string" || !deps.cleanupPrompt.trim())
  ) {
    throw new Error("transcribe: cleanupPrompt is not a non-empty string");
  }
  if (deps.callCleanup !== undefined && typeof deps.callCleanup !== "function") {
    throw new Error("transcribe: callCleanup is not a function");
  }
}

/** Validate raw ASR output into turns: drop empties, enforce time order. */
export function parseTurns(raw: unknown): TranscriptTurn[] {
  if (!Array.isArray(raw)) {
    throw new Error("transcribe: ASR output is not a turn array");
  }
  const turns: TranscriptTurn[] = [];
  for (let i = 0; i < raw.length; i++) {
    const t = raw[i] as Record<string, unknown>;
    if (t === null || typeof t !== "object" || Array.isArray(t)) {
      throw new Error(`transcribe: turn ${i} is not an object`);
    }
    if (typeof t.startSec !== "number" || !Number.isFinite(t.startSec) || t.startSec < 0) {
      throw new Error(`transcribe: turn ${i} has no valid startSec`);
    }
    // endSec must be finite too, like startSec: a NaN endSec slipped
    // through before, because NaN < startSec is false, and an
    // Infinity endSec passed the same way; both would then ride
    // into the transcript turns unchecked.
    if (
      t.endSec !== undefined &&
      (typeof t.endSec !== "number" || !Number.isFinite(t.endSec) || t.endSec < t.startSec)
    ) {
      throw new Error(`transcribe: turn ${i} has an invalid endSec`);
    }
    if (typeof t.text !== "string") {
      throw new Error(`transcribe: turn ${i} has no text`);
    }
    const text = t.text.trim();
    if (!text) continue;
    turns.push({
      startSec: t.startSec,
      ...(t.endSec !== undefined ? { endSec: t.endSec } : {}),
      text,
    });
  }
  turns.sort((a, b) => a.startSec - b.startSec);
  return turns;
}

/** Build the "[t] text" string from turns, one line per turn. */
export function buildTranscript(turns: TranscriptTurn[]): string | null {
  // A non-array or malformed turn would otherwise throw a raw
  // TypeError from .length/.toFixed below, with no step name to
  // trace it to. Reject both here with a named error, the same
  // named-error rule parseTurns above already follows. Valid
  // callers are unchanged: turns always come from parseTurns (or
  // applyCleanup over them), so they are arrays of finite-startSec,
  // string-text turns.
  if (!Array.isArray(turns)) {
    throw new Error("transcribe: turns must be an array");
  }
  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i] as unknown;
    if (turn === null || typeof turn !== "object" || Array.isArray(turn)) {
      throw new Error(`transcribe: turn ${i} is not an object`);
    }
    const rec = turn as Record<string, unknown>;
    if (typeof rec.startSec !== "number" || !Number.isFinite(rec.startSec)) {
      throw new Error(`transcribe: turn ${i} has no valid startSec`);
    }
    if (typeof rec.text !== "string") {
      throw new Error(`transcribe: turn ${i} has no valid text`);
    }
  }
  if (turns.length === 0) return null;
  return turns.map((t) => `[${t.startSec.toFixed(1)}] ${t.text}`).join("\n");
}

/**
 * Parse cleaned lines back into turns by their [t] prefix, keeping
 * endSec from the raw turn. Returns null when the line count or any
 * prefix changed, so the caller discards the cleanup and uses raw.
 */
export function applyCleanup(
  rawTurns: TranscriptTurn[],
  cleanedText: string,
): TranscriptTurn[] | null {
  const lines = cleanedText
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length !== rawTurns.length) return null;
  const out: TranscriptTurn[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^\[(\d+(?:\.\d+)?)\]\s*(.*)$/.exec(lines[i]);
    if (!m) return null;
    if (Math.abs(parseFloat(m[1]) - rawTurns[i].startSec) > 0.051) return null;
    const text = m[2].trim();
    if (!text) return null;
    out.push({
      startSec: rawTurns[i].startSec,
      ...(rawTurns[i].endSec !== undefined ? { endSec: rawTurns[i].endSec } : {}),
      text,
    });
  }
  return out;
}

function audioByteLength(base64: string): number {
  const stripped = base64.replace(/\s/g, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(stripped) || stripped.length % 4 !== 0) {
    throw new Error("transcribe: audioWavBase64 is not valid base64");
  }
  return Math.floor((stripped.length * 3) / 4);
}

export async function runTranscribe(
  input: TranscribeInput,
  deps: TranscribeDeps,
): Promise<TranscribeOutput> {
  validateTranscribeInput(input);
  if (!input.audioWavBase64) {
    return { transcript: null, transcriptTurns: [] };
  }
  // After the skip checks but before the call, so a validation throw
  // is never paid for and never swallowed as a model failure.
  validateTranscribeDeps(deps);
  const bytes = audioByteLength(input.audioWavBase64);
  if (bytes > MAX_AUDIO_BYTES) {
    throw new Error(
      `transcribe: audio is ${bytes} bytes, over the ${MAX_AUDIO_BYTES} byte limit`,
    );
  }
  // A file shorter than 12 bytes can never hold a RIFF/WAVE header, so
  // it used to skip this check entirely and ride to the model caller
  // as garbage; fail fast with the same WAV error instead.
  if (bytes < 12) {
    throw new Error("transcribe: audio is not a WAV file (missing RIFF/WAVE header)");
  }
  const head = Buffer.from(input.audioWavBase64, "base64").subarray(0, 12).toString("latin1");
  if (head.slice(0, 4) !== "RIFF" || head.slice(8, 12) !== "WAVE") {
    throw new Error("transcribe: audio is not a WAV file (missing RIFF/WAVE header)");
  }
  // A WAV in a format Meta transcribe refuses (anything but mono
  // s16le at 16000 or 24000 Hz) used to pass the header check and
  // spend a paid ASR call, only to fail at the provider with a 400
  // (spike, Oct 28: 8 kHz rejected). The route validator already
  // rejects it on "uploading"; a direct runTranscribe caller gets
  // the same fail-fast here, before any fetch. The fmt chunk is
  // found by scanning RIFF chunks, not by assuming it sits at
  // offset 12, so a leading chunk does not break it. A WAV with no
  // fmt chunk in the decoded head passes, like the route validator,
  // and is left to the provider.
  {
    const fmtHead = Buffer.from(input.audioWavBase64.replace(/\s/g, "").slice(0, 268), "base64");
    let off = 12;
    while (off + 8 <= fmtHead.length) {
      const id = fmtHead.subarray(off, off + 4).toString("latin1");
      const size = fmtHead.readUInt32LE(off + 4);
      if (id === "fmt " && size >= 16 && off + 8 + 16 <= fmtHead.length) {
        const format = fmtHead.readUInt16LE(off + 8);
        const channels = fmtHead.readUInt16LE(off + 10);
        const sampleRate = fmtHead.readUInt32LE(off + 12);
        const bits = fmtHead.readUInt16LE(off + 22);
        if (
          format !== 1 ||
          channels !== 1 ||
          (sampleRate !== 16000 && sampleRate !== 24000) ||
          bits !== 16
        ) {
          throw new Error(
            `transcribe: audio must be mono s16le WAV at 16000 or 24000 Hz ` +
              `(got format ${format}, ${channels} channel(s), ${sampleRate} Hz, ${bits}-bit)`,
          );
        }
        break;
      }
      off += 8 + size + (size % 2);
    }
  }

  let res: Awaited<ReturnType<TranscribeCaller>>;
  try {
    res = await deps.callTranscribe({
      model: TRANSCRIBE_MODEL,
      mode: "standard",
      audioWavBase64: input.audioWavBase64,
      keywordBias: deps.keywordBias ?? DEFAULT_KEYWORD_BIAS,
      signal: deps.signal,
    });
  } catch (err) {
    // A billed-but-failed ASR call still spent money (e.g. MetaCallError
    // on a non-JSON response): record it before rethrowing, so the
    // route total counts it. runPlan continues without narration on
    // the rethrow, and a tracker throw (spike cap) replaces it as a
    // spending stop, same pattern as reason/cost.
    recordFailedCall(deps.tracker, TRANSCRIBE_MODEL, "transcribe", err);
    throw err;
  }
  // The tracker enforces the spike cap: a throw here stops the run.
  deps.tracker.record({
    model: TRANSCRIBE_MODEL,
    step: "transcribe",
    latencyMs: res.latencyMs,
    costUsd: res.costUsd,
  });

  const rawTurns = parseTurns(res.turns);
  if (rawTurns.length === 0) {
    return { transcript: null, transcriptTurns: [] };
  }

  let turns = rawTurns;
  if (deps.cleanupPrompt && deps.callCleanup) {
    const rawText = buildTranscript(rawTurns) as string;
    const prompt = deps.cleanupPrompt
      .replaceAll("{{raw_turns}}", rawText)
      .replaceAll("{{space_type}}", input.spaceType && input.spaceType.trim() ? input.spaceType : "room")
      .replaceAll("{{keyword_bias}}", (deps.keywordBias ?? DEFAULT_KEYWORD_BIAS).join(", "));
    let cleaned: Awaited<ReturnType<CleanupCaller>>;
    try {
      cleaned = await deps.callCleanup({ model: CLEANUP_MODEL, prompt, signal: deps.signal });
    } catch (err) {
      // Same as the ASR call above: a billed-but-failed cleanup call
      // is recorded before rethrowing, so the route total counts it;
      // runPlan still continues without narration, as on any other
      // cleanup throw. A tracker throw (spike cap) replaces it as a
      // spending stop.
      recordFailedCall(deps.tracker, CLEANUP_MODEL, "transcribe-cleanup", err);
      throw err;
    }
    deps.tracker.record({
      model: CLEANUP_MODEL,
      step: "transcribe-cleanup",
      latencyMs: cleaned.latencyMs,
      costUsd: cleaned.costUsd,
    });
    // Discard the cleanup if it changed line count or any prefix.
    turns = applyCleanup(rawTurns, cleaned.text) ?? rawTurns;
  }

  return { transcript: buildTranscript(turns), transcriptTurns: turns };
}
