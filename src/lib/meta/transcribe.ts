/**
 * SightWork Muse Voice Transcribe caller (transcribe step).
 *
 * This is the caller the transcribe step injects (see src/lib/pipeline/transcribe.ts):
 * the step itself records every call on the usage tracker, so the $10
 * spike cap is still enforced there.
 *
 * - Base URL: https://api.meta.ai/v1 (ASR API, NOT the Responses API).
 *   Override with opts.baseUrl or the META_API_BASE_URL env var.
 * - Key: opts.apiKey, or MODEL_API_KEY, or META_API_KEY from the
 *   environment. The key is never logged, never stored, and never sent
 *   anywhere except the Authorization header of the Meta API call.
 * - This module makes no call on import. No call happens until a caller
 *   returned here is invoked, and tests inject a fake fetch instead.
 * - Shape verified live by the spike (Oct 26): POST
 *   /v1/asr/transcribe?sessionId=<id>, multipart/form-data with a
 *   `request` JSON part and an `audio` WAV part. The step passes
 *   mode "standard" (non-diarization, non-contributor); the wire mode
 *   that actually returns turns with diarization off is "ENDPOINTING"
 *   (PUSH_TO_TALK returns turns: [] and only a flat transcript), so
 *   that is what this caller sends. There is no contributor variant
 *   for ASR, so the never-contributor rule is met automatically.
 * - Response: { sessionId, transcript, audioDurationMs, turns: [{
 *   turnId, startMs, endMs, transcript }] }. Turns map to the step's
 *   { startSec, endSec, text } (startMs/1000, endMs/1000, transcript).
 *   No narration is a 200 with an empty transcript and turns: [];
 *   the caller returns turns: [] and the step turns that into
 *   transcript null, transcriptTurns [] — not an error. But when
 *   turns carry no spoken text and the flat transcript is
 *   non-empty, the caller keeps it as one turn (0 to audio
 *   duration) instead of dropping it — see the fallback below.
 * - Cost: $0.18/hour, billed by whole seconds rounded down:
 *   floor(audioDurationMs/1000)/3600*0.18. There is no usage field,
 *   so the caller computes it (spike: 42 s cost $0.0021). When the
 *   response omits audioDurationMs, the last turn's endMs is used.
 * - A 200 whose turns do not parse still spent the call (ASR bills by
 *   audio length): when the response carries a usable audioDurationMs,
 *   the throw is an AsrCallError carrying that priced cost and latency,
 *   so the transcribe step's recordFailedCall records it instead of
 *   dropping it from the route total, the same shape as
 *   SamCallError/BasetenCallError/MetaCallError/ImageCallError. When
 *   the response carries no usable duration, the parse failure cannot
 *   be priced, so it keeps the plain error, verbatim.
 * - A 200 body that is not JSON likewise cannot be priced (the
 *   duration lives inside the body that failed to parse), so it
 *   throws a plain named Error("asr: response was not JSON") instead
 *   of res.json()'s raw SyntaxError, and recordFailedCall records
 *   nothing; no spend is invented.
 * - A transient 404 model_not_found is retried, up to 3 attempts with a
 *   short backoff (250 ms, then 500 ms): the Oct 28 spike showed Meta's
 *   entitlement cache serving 404s intermittently for a model that then
 *   returns 200, and those 404s are not billed, so one bad hop no longer
 *   skips the whole transcribe step. A 500 is still retried once, with no
 *   backoff (spike note); any other error, a 404 without model_not_found,
 *   or a 404 that survives all 3 attempts still throws at once, with
 *   status + body, per the pipeline's rule.
 */

export interface AsrClientOptions {
  apiKey?: string;
  baseUrl?: string;
  /** Injectable fetch for tests. Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Injectable sleep for tests. Defaults to a real setTimeout wait. */
  sleepImpl?: (ms: number) => Promise<void>;
  /** USD per hour of audio. Default: $0.18 (spike-verified). */
  pricePerHourUsd?: number;
}

/** One ASR turn, already in the transcribe step's shape. */
export interface AsrTurn {
  startSec: number;
  endSec: number;
  text: string;
}

export interface AsrTranscribeCaller {
  (req: {
    model: string;
    /** Step's mode literal; the wire mode sent is ENDPOINTING (see header). */
    mode: "standard";
    audioWavBase64: string;
    keywordBias: string[];
    /**
     * Abort signal for a stopped run (2026-11-01): when set, it is
     * passed to the fetch, and an already-aborted signal throws an
     * AbortError before any fetch, so a stopped run never starts
     * a paid ASR call. Omit it and the call runs as before.
     */
    signal?: AbortSignal;
  }): Promise<{ turns: AsrTurn[]; latencyMs: number; costUsd: number }>;
}

/**
 * An ASR call that was billed but failed after the provider answered:
 * a 200 whose turns do not parse. Carries the priced cost (from the
 * response's audioDurationMs) and latency so the transcribe step's
 * recordFailedCall can record the spend instead of dropping it from
 * the route total, the same shape as
 * SamCallError/BasetenCallError/MetaCallError/ImageCallError. Only
 * thrown when the response carries a usable duration; without one
 * the failure cannot be priced and keeps the plain error.
 */
export class AsrCallError extends Error {
  readonly costUsd: number;
  readonly latencyMs: number;
  constructor(message: string, costUsd: number, latencyMs: number) {
    super(message);
    this.name = "AsrCallError";
    this.costUsd = costUsd;
    this.latencyMs = latencyMs;
  }
}

const DEFAULT_BASE_URL = "https://api.meta.ai/v1";
const DEFAULT_PRICE_PER_HOUR_USD = 0.18;

/** Total attempts for a transient 404 model_not_found. */
const MAX_ASR_ATTEMPTS = 3;
/** Max audio per ASR call, matching the transcribe step's MAX_AUDIO_BYTES (src/lib/pipeline/transcribe.ts: 32 MB). */
const MAX_ASR_AUDIO_BYTES = 32 * 1024 * 1024;
/** Backoff between those attempts: 250 ms after attempt 1, 500 ms after 2. */
const ASR_RETRY_DELAYS_MS = [250, 500];

/** Wire mode that returns turns with diarization off (spike-verified). */
export const ASR_MODE = "ENDPOINTING" as const;

/** Cost of audio of the given length, whole seconds rounded down. */
export function computeAsrCostUsd(durationMs: number, pricePerHourUsd = DEFAULT_PRICE_PER_HOUR_USD): number {
  // A bad duration or price would otherwise surface later, mid-run,
  // when the transcribe step records the call and the usage tracker
  // rejects it with a generic cost message. The caller checks the
  // provider duration only for finiteness, so a negative duration
  // would reach here; reject both bad inputs here, at the cost
  // computation, like the caller rejects a bad price at creation.
  if (!Number.isFinite(durationMs) || durationMs < 0) {
    throw new Error(`asr: durationMs must be a finite number >= 0, got ${durationMs}`);
  }
  if (!Number.isFinite(pricePerHourUsd) || pricePerHourUsd < 0) {
    throw new Error(`asr: pricePerHourUsd must be a finite number >= 0, got ${pricePerHourUsd}`);
  }
  return (Math.floor(durationMs / 1000) / 3600) * pricePerHourUsd;
}

function readEnv(name: string): string | undefined {
  try {
    const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
    const v = env?.[name];
    return v && v.trim() ? v : undefined;
  } catch {
    return undefined;
  }
}

function mapTurns(raw: unknown): AsrTurn[] {
  if (!Array.isArray(raw)) throw new Error("asr: response turns is not an array");
  return raw.map((t, i) => {
    if (t === null || typeof t !== "object" || Array.isArray(t)) {
      throw new Error(`asr: turn ${i} is not an object`);
    }
    const turn = t as Record<string, unknown>;
    if (typeof turn.startMs !== "number" || !Number.isFinite(turn.startMs) || turn.startMs < 0) {
      throw new Error(`asr: turn ${i} has no valid startMs`);
    }
    if (typeof turn.endMs !== "number" || !Number.isFinite(turn.endMs) || turn.endMs < turn.startMs) {
      throw new Error(`asr: turn ${i} has no valid endMs`);
    }
    if (typeof turn.transcript !== "string") {
      throw new Error(`asr: turn ${i} has no transcript text`);
    }
    return { startSec: turn.startMs / 1000, endSec: turn.endMs / 1000, text: turn.transcript };
  });
}

export function createAsrTranscribeCaller(opts: AsrClientOptions = {}): AsrTranscribeCaller {
  const apiKey = opts.apiKey ?? readEnv("MODEL_API_KEY") ?? readEnv("META_API_KEY");
  if (!apiKey) {
    throw new Error(
      "asr: no API key found. Set MODEL_API_KEY (or META_API_KEY) in the environment; the key is never committed or logged.",
    );
  }
  const baseUrl = (opts.baseUrl ?? readEnv("META_API_BASE_URL") ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleepImpl =
    opts.sleepImpl ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const pricePerHour = opts.pricePerHourUsd ?? DEFAULT_PRICE_PER_HOUR_USD;
  // A bad hourly price would only surface later, mid-run, when the
  // transcribe step records the call and the usage tracker rejects it.
  // Reject it here, at caller creation, like the tracker rejects bad
  // opts, so a misconfigured price fails fast before any ASR call.
  if (!Number.isFinite(pricePerHour) || pricePerHour < 0) {
    throw new Error(`asr: pricePerHourUsd must be a finite number >= 0, got ${opts.pricePerHourUsd}`);
  }

  return async (req) => {
    // A direct caller bypassing the transcribe step used to get a raw
    // TypeError here: a null request reading .model, with no step
    // name. Fail fast with a named asr error, before any fetch,
    // the same named-error rule the SAM and Image callers follow
    // for their requests. Valid requests are unchanged.
    if (req === null || typeof req !== "object" || Array.isArray(req)) {
      throw new Error("asr: request must be an object");
    }
    // A bad request would otherwise spend a paid ASR call and only
    // fail downstream, when the transcribe step parses an empty or
    // garbage result. Reject it here, before any fetch, like the
    // SAM and Image callers reject bad requests at the same point.
    if (typeof req.model !== "string" || req.model.trim().length === 0) {
      throw new Error("asr: model must be a non-empty string");
    }
    if (req.mode !== "standard") {
      throw new Error(`asr: mode must be "standard", got ${String(req.mode)}`);
    }
    if (typeof req.audioWavBase64 !== "string" || req.audioWavBase64.trim().length === 0) {
      throw new Error("asr: audioWavBase64 must be a non-empty string");
    }
    const b64 = req.audioWavBase64.trim();
    if (b64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64) || Buffer.from(b64, "base64").length === 0) {
      throw new Error("asr: audioWavBase64 must be valid base64 audio data");
    }
    // Valid base64 is not necessarily WAV: a PNG or other payload
    // would otherwise ride along on a paid ASR call and only fail at
    // the provider. Reject anything without a WAV header ("RIFF" at
    // bytes 0-3, "WAVE" at bytes 8-11) here, before any fetch, like
    // the image callers reject non-image base64 at the same point.
    // A payload too short to hold the header fails.
    const wavHead = Buffer.from(b64, "base64");
    if (
      wavHead.length < 12 ||
      wavHead.toString("ascii", 0, 4) !== "RIFF" ||
      wavHead.toString("ascii", 8, 12) !== "WAVE"
    ) {
      throw new Error("asr: audioWavBase64 must decode to WAV audio (RIFF/WAVE header)");
    }
    // The transcribe step already caps audio at 32 MB before calling,
    // but a direct caller bypassing the step had no bound: a huge WAV
    // would ride along on a paid ASR call (billed by audio length)
    // before any cap could stop it, the same shape as the Spark
    // 48-image and Image n caps. Reject it here, before any fetch;
    // 32 MB matches the step's cap, so no current pipeline call changes.
    if (wavHead.length > MAX_ASR_AUDIO_BYTES) {
      throw new Error(
        `asr: audioWavBase64 must be at most 32 MB, got ${wavHead.length} bytes`,
      );
    }
    // A whitespace-only keyword would otherwise ride along on a paid
    // ASR call and only fail (or silently do nothing) at the provider:
    // the old check accepted any string. Reject it here, before any
    // fetch, like the transcribe step rejects blank keywords in its
    // own deps check. Valid keywords pass through unchanged.
    if (
      !Array.isArray(req.keywordBias) ||
      req.keywordBias.some((k) => typeof k !== "string" || k.trim().length === 0)
    ) {
      throw new Error("asr: keywordBias must be an array of non-empty strings");
    }
    // A stopped run never starts a paid call: an already-aborted
    // signal throws here, before any fetch, with the same AbortError
    // name the fetch itself produces mid-flight, so the transcribe
    // step and runPlan treat both the same (not a step failure). A
    // signal that aborts mid-flight rejects from the fetch itself.
    if (req.signal?.aborted) {
      const err = new Error("asr: aborted");
      err.name = "AbortError";
      throw err;
    }
    const sessionId = `sightwork-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const audioBytes = Buffer.from(req.audioWavBase64, "base64");
    const started = Date.now();
    let lastStatus = 0;
    let lastDetail = "";
    for (let attempt = 0; attempt < MAX_ASR_ATTEMPTS; attempt++) {
      // Rebuilt per attempt: a multipart body already sent must not be
      // re-sent on a retry, and the sessionId stays the same across
      // retries of the same request.
      const form = new FormData();
      form.append(
        "request",
        new Blob(
          [
            JSON.stringify({
              mode: ASR_MODE,
              model: req.model,
              audioEncoding: "WAV",
              keywords: req.keywordBias,
            }),
          ],
          { type: "application/json" },
        ),
      );
      form.append("audio", new Blob([audioBytes], { type: "audio/wav" }), "audio.wav");
      const res = await fetchImpl(`${baseUrl}/asr/transcribe?sessionId=${encodeURIComponent(sessionId)}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form,
        signal: req.signal,
      });
      if (res.ok) {
        const latencyMs = Date.now() - started;
        // A 200 body that is not JSON carries no duration to price
        // (ASR bills by audio length, and the duration lives inside
        // the body that failed to parse), so it cannot be priced and
        // keeps a plain named error — res.json() used to throw a raw
        // SyntaxError here, surfacing parser internals instead of the
        // caller and the cause. The step's recordFailedCall records
        // nothing for a plain error, as for any unpriceable failure,
        // and no spend is invented.
        let parsed: Record<string, unknown>;
        try {
          parsed = (await res.json()) as Record<string, unknown>;
        } catch {
          throw new Error("asr: response was not JSON");
        }
        // A 200 whose turns do not parse was still billed (ASR bills
        // by audio length): when the response carries a usable
        // duration, carry the priced cost on the throw so the step's
        // recordFailedCall records it; without a usable duration the
        // failure cannot be priced, so it keeps the plain error.
        let turns: AsrTurn[];
        try {
          turns = mapTurns(parsed.turns);
        } catch (err) {
          const rawDuration = parsed.audioDurationMs;
          if (typeof rawDuration === "number" && Number.isFinite(rawDuration) && rawDuration >= 0) {
            throw new AsrCallError(
              err instanceof Error ? err.message : String(err),
              computeAsrCostUsd(rawDuration, pricePerHour),
              latencyMs,
            );
          }
          throw err;
        }
        const durationMs =
          typeof parsed.audioDurationMs === "number" && Number.isFinite(parsed.audioDurationMs)
            ? parsed.audioDurationMs
            : turns.length > 0
              ? turns[turns.length - 1].endSec * 1000
              : 0;
        // Flat-transcript fallback: the provider also returns a flat
        // `transcript` string, and one wire mode returns turns: []
        // with only that flat string. The step turns an empty turn
        // list into transcript null, so a flat-only response used
        // to drop the narration entirely. When no turn carries
        // spoken text but the flat transcript is non-empty, keep
        // it as a single turn spanning the audio, so the plan
        // shows the narration instead of "No narration". Turns
        // with spoken text always win; the flat string never
        // overrides them.
        const flatTranscript =
          typeof parsed.transcript === "string" ? parsed.transcript.trim() : "";
        const hasSpokenTurn = turns.some((t) => t.text.trim().length > 0);
        const finalTurns =
          !hasSpokenTurn && flatTranscript
            ? [{ startSec: 0, endSec: durationMs / 1000, text: flatTranscript }]
            : turns;
        return { turns: finalTurns, latencyMs, costUsd: computeAsrCostUsd(durationMs, pricePerHour) };
      }
      lastStatus = res.status;
      lastDetail = await res.text();
      // Only a 404 naming model_not_found is transient (spike, Oct 28:
      // unbilled, then 200 for the same model). A 500 is still retried
      // once, with no backoff, as before. Anything else throws at
      // once, as before, and so does a 404 that survives all attempts.
      const transient404 = res.status === 404 && lastDetail.includes("model_not_found");
      if (transient404) {
        if (attempt === MAX_ASR_ATTEMPTS - 1) break;
        await sleepImpl(ASR_RETRY_DELAYS_MS[attempt] ?? 500);
        continue;
      }
      if (res.status === 500 && attempt === 0) continue;
      break;
    }
    throw new Error(`asr: ${lastStatus} ${lastDetail}`);
  };
}
