/**
 * SightWork SAM 3.1 caller (segment step).
 *
 * This is the caller the segment step injects (see src/lib/pipeline/segment.ts):
 * one concept on one frame per request, over the Meta Responses API.
 * The step itself records every call on the usage tracker, so the $10
 * spike cap is still enforced there.
 *
 * - Base URL: https://api.meta.ai/v1 (Responses API, POST /responses).
 *   Override with opts.baseUrl or the META_API_BASE_URL env var.
 * - Key: opts.apiKey, or MODEL_API_KEY, or META_API_KEY from the
 *   environment. The key is never logged, never stored, and never sent
 *   anywhere except the Authorization header of the Meta API call.
 * - This module makes no call on import. No call happens until a caller
 *   returned here is invoked, and tests inject a fake fetch instead.
 * - Scores need metadata.include_confidence as the STRING "true", not a
 *   boolean: without it SAM returns no `c` on the box tokens and the
 *   segment step's minScore filter has nothing to filter on (spike
 *   note, Oct 26). mask_encoding "one_bit" keeps payloads smallest;
 *   masks are not used downstream, so they are parsed out and dropped.
 * - Cost: $2.50 per 1,000 images = $0.0025 per request (one concept on
 *   one frame). The spike wiring may override via opts once live
 *   billing is confirmed.
 * - Provider errors are surfaced verbatim (status + body) so a failing
 *   step fails loudly instead of guessing, per the segment step's rule.
 * - A transient 404 model_not_found is retried, up to 3 attempts with a
 *   short backoff (250 ms, then 500 ms): the Oct 28 spike showed Meta's
 *   entitlement cache serving 404s intermittently for a model that then
 *   returns 200, and those 404s are not billed, so one bad hop no longer
 *   skips the whole segment step (and with it the after image). Any other
 *   error, or a 404 without model_not_found, still throws at once, and a
 *   404 that survives all 3 attempts throws with the last response.
 * - Empty output_text is a valid result (zero matches), not an error.
 */

import type { Box } from "../types";

export interface SamClientOptions {
  apiKey?: string;
  baseUrl?: string;
  /** Injectable fetch for tests. Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Injectable sleep for tests. Defaults to a real setTimeout wait. */
  sleepImpl?: (ms: number) => Promise<void>;
  /** USD charged per request. Default: $2.50 per 1,000 images. */
  requestCostUsd?: number;
}

/** One SAM instance, box already normalized to 0-1000 [x1, y1, x2, y2]. */
export interface SamInstance {
  score: number;
  box?: Box;
}

export interface SamSegmentCaller {
  (req: {
    model: string;
    /** Noun-phrase concept, e.g. "chair". */
    concept: string;
    /** Index into the plan's frames array. */
    frameIndex: number;
    /** Data URL of the still image. */
    dataUrl: string;
    /**
     * Abort signal for a stopped run (2026-11-01): when set, it is
     * passed to the fetch, and an already-aborted signal throws an
     * AbortError before any fetch, so a stopped run never starts
     * (or pays for) a SAM call it no longer needs.
     */
    signal?: AbortSignal;
  }): Promise<{ instances: SamInstance[]; latencyMs: number; costUsd: number }>;
}

const DEFAULT_BASE_URL = "https://api.meta.ai/v1";
const DEFAULT_REQUEST_COST_USD = 0.0025;

/** Total attempts for a transient 404 model_not_found, per the Oct 26 review. */
const MAX_SAM_ATTEMPTS = 3;
/** Max decoded bytes per frame. Frames are 1024 px JPEGs (tools/frames/sample-frames.mjs), so 5 MB leaves wide headroom while bounding a direct caller that bypasses the segment step, the same shape as the Baseten caller's 5 MB image cap and the ASR caller's 32 MB audio cap. */
const MAX_SAM_IMAGE_BYTES = 5 * 1024 * 1024;
/** Backoff between those attempts: 250 ms after attempt 1, 500 ms after 2. */
const SAM_RETRY_DELAYS_MS = [250, 500];

/** The SAM request must carry confidence as a string, not a boolean. */
export const SAM_METADATA = {
  include_confidence: "true",
  mask_encoding: "one_bit",
} as const;

/**
 * A SAM call that was billed but failed after the provider answered:
 * a 200 with no text output, output_text whose box tokens do not
 * parse, or a 200 body that is not JSON at all. Carries the flat
 * per-request cost and latency so the segment step's recordFailedCall
 * can record the spend instead of dropping it from the route total,
 * the same shape as BasetenCallError/MetaCallError.
 */
export class SamCallError extends Error {
  readonly costUsd: number;
  readonly latencyMs: number;
  constructor(message: string, costUsd: number, latencyMs: number) {
    super(message);
    this.name = "SamCallError";
    this.costUsd = costUsd;
    this.latencyMs = latencyMs;
  }
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

function extractText(body: Record<string, unknown>): string | null {
  if (typeof body.output_text === "string") return body.output_text;
  const output = body.output;
  if (!Array.isArray(output)) return null;
  for (const item of output) {
    if (item === null || typeof item !== "object") continue;
    const content = (item as Record<string, unknown>).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (part !== null && typeof part === "object" && (part as Record<string, unknown>).type === "output_text") {
        const text = (part as Record<string, unknown>).text;
        if (typeof text === "string") return text;
      }
    }
  }
  return null;
}

function parseNumber(fields: Record<string, string>, key: string): number {
  const raw = fields[key];
  if (raw === undefined) throw new Error(`sam: box token is missing ${key}`);
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`sam: box token has a non-numeric ${key}`);
  return value;
}

/**
 * Parse SAM's special-token output_text into instances. Only box tokens
 * are read; mask tokens are ignored. Boxes arrive in source pixels with
 * w/h on the token and are normalized to 0-1000 here, as the segment
 * step expects. A box token without a score fails loudly: without `c`
 * the segment step cannot apply its minScore filter. A box outside the
 * image fails loudly too, instead of riding on as an out-of-range
 * normalized box the segment step would have to reject.
 */
export function parseSamOutput(outputText: string): SamInstance[] {
  const instances: SamInstance[] = [];
  const tokenPattern = /<\|box;([^|]*)\|>/g;
  let match: RegExpExecArray | null;
  while ((match = tokenPattern.exec(outputText)) !== null) {
    const fields: Record<string, string> = {};
    for (const pair of match[1].split(";")) {
      const eq = pair.indexOf("=");
      if (eq > 0) fields[pair.slice(0, eq)] = pair.slice(eq + 1);
    }
    const w = parseNumber(fields, "w");
    const h = parseNumber(fields, "h");
    if (w <= 0 || h <= 0) throw new Error("sam: box token has a non-positive w or h");
    const x1 = parseNumber(fields, "x1");
    const y1 = parseNumber(fields, "y1");
    const x2 = parseNumber(fields, "x2");
    const y2 = parseNumber(fields, "y2");
    const score = parseNumber(fields, "c");
    if (score < 0 || score > 1) throw new Error("sam: box token score is outside 0-1");
    const box: Box = [
      Math.round((x1 / w) * 1000),
      Math.round((y1 / h) * 1000),
      Math.round((x2 / w) * 1000),
      Math.round((y2 / h) * 1000),
    ];
    if (box[0] > box[2] || box[1] > box[3]) {
      throw new Error("sam: box token has an inverted box");
    }
    // Normalized boxes are promised 0-1000 (see SamInstance): a token
    // past the image edge used to pass here and only fail downstream
    // in the segment step's 0-1000 check, with a segment: message that
    // hid that the SAM output itself was out of range. Fail here, at
    // the SAM boundary, naming the normalized box.
    if (box.some((v) => v < 0 || v > 1000)) {
      throw new Error(
        `sam: box token is outside the image (normalized box ${box.join(",")})`,
      );
    }
    instances.push({ score, box });
  }
  return instances;
}

/** Base64 alphabet plus up to two padding chars, length a multiple of 4. */
function isBase64(value: string): boolean {
  const stripped = value.replace(/\s/g, "");
  return /^[A-Za-z0-9+/]*={0,2}$/.test(stripped) && stripped.length % 4 === 0;
}

/**
 * True when the base64 string decodes to a real image header, by the
 * same magic-byte rule the route validator uses: JPEG (FF D8 FF),
 * PNG (89 50 4E 47 0D 0A 1A 0A), GIF ("GIF87a"/"GIF89a"), or WebP
 * ("RIFF" + "WEBP" at bytes 8-11). Only the first 12 bytes are
 * decoded, with atob (not Buffer) so this pure module stays free of
 * node types. A payload too short to hold any header fails.
 */
function isImageBase64(value: string): boolean {
  const stripped = value.replace(/\s/g, "");
  const chunk = stripped.slice(0, 16);
  if (chunk.length < 8) return false;
  const head = atob(chunk.length % 4 === 0 ? chunk : chunk.slice(0, chunk.length - (chunk.length % 4)));
  const b = (i: number): number => head.charCodeAt(i);
  if (head.length >= 3 && b(0) === 0xff && b(1) === 0xd8 && b(2) === 0xff) return true;
  if (
    head.length >= 8 &&
    b(0) === 0x89 && b(1) === 0x50 && b(2) === 0x4e && b(3) === 0x47 &&
    b(4) === 0x0d && b(5) === 0x0a && b(6) === 0x1a && b(7) === 0x0a
  ) return true;
  if (head.length >= 6 && head.slice(0, 6) === "GIF87a") return true;
  if (head.length >= 6 && head.slice(0, 6) === "GIF89a") return true;
  if (head.length >= 12 && head.slice(0, 4) === "RIFF" && head.slice(8, 12) === "WEBP") return true;
  return false;
}

export function createSamSegmentCaller(opts: SamClientOptions = {}): SamSegmentCaller {
  const apiKey = opts.apiKey ?? readEnv("MODEL_API_KEY") ?? readEnv("META_API_KEY");
  if (!apiKey) {
    throw new Error(
      "sam: no API key found. Set MODEL_API_KEY (or META_API_KEY) in the environment; the key is never committed or logged.",
    );
  }
  const baseUrl = (opts.baseUrl ?? readEnv("META_API_BASE_URL") ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleepImpl =
    opts.sleepImpl ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const requestCost = opts.requestCostUsd ?? DEFAULT_REQUEST_COST_USD;
  // A bad per-request cost would only surface later, mid-run, when the
  // segment step records the call and the usage tracker rejects it.
  // Reject it here, at caller creation, like the tracker rejects bad
  // opts, so a misconfigured cost fails fast before any SAM call.
  if (!Number.isFinite(requestCost) || requestCost < 0) {
    throw new Error(`sam: requestCostUsd must be a finite number >= 0, got ${opts.requestCostUsd}`);
  }

  return async (req) => {
    // A direct caller bypassing the segment step used to get a raw
    // TypeError here: a null request reading .model, with no step
    // name. Fail fast with a named sam error, before any fetch,
    // the same named-error rule the model/concept checks below
    // follow. Valid requests are unchanged.
    if (req === null || typeof req !== "object" || Array.isArray(req)) {
      throw new Error("sam: request must be an object");
    }
    // A bad request would otherwise spend a paid SAM call and only
    // fail downstream, when the segment step parses an empty or
    // garbage result. Reject it here, before any fetch, like the
    // other callers reject bad costs at creation.
    if (typeof req.model !== "string" || req.model.trim().length === 0) {
      throw new Error("sam: model must be a non-empty string");
    }
    if (typeof req.concept !== "string" || req.concept.trim().length === 0) {
      throw new Error("sam: concept must be a non-empty string");
    }
    if (!Number.isInteger(req.frameIndex) || req.frameIndex < 0) {
      throw new Error(`sam: frameIndex must be an integer >= 0, got ${String(req.frameIndex)}`);
    }
    // Parity with the segment step's validateSegmentInput and the
    // route validator: a dataUrl must be a data:image base64 URL
    // carrying a real image header. A bare string, a data:text URL,
    // garbage base64, or a text blob re-labelled as an image used to
    // pass the non-empty check here and spend a paid SAM call, only
    // to fail at the provider, while the segment step already
    // rejected the same input. A direct SAM caller gets the same
    // fail-fast here, before any fetch. Valid dataUrls still pass
    // through unchanged.
    if (typeof req.dataUrl !== "string" || req.dataUrl.trim().length === 0) {
      throw new Error("sam: dataUrl must be a non-empty string");
    }
    if (!req.dataUrl.startsWith("data:image/") || !req.dataUrl.includes(";base64,")) {
      throw new Error("sam: dataUrl must be a data:image base64 URL");
    }
    {
      const payload = req.dataUrl.slice(req.dataUrl.indexOf(";base64,") + 8);
      if (payload.length === 0 || !isBase64(payload)) {
        throw new Error("sam: dataUrl must carry valid base64 image data");
      }
      if (!isImageBase64(payload)) {
        throw new Error("sam: dataUrl must carry image data (JPEG, PNG, WebP, or GIF)");
      }
      // Same shape as the Baseten caller's image cap: the segment
      // step's frames are small, but a direct caller bypassing the
      // step had no bound, so an unbounded frame would ride onto a
      // paid SAM call before any cap could stop it. 5 MB decoded is
      // wide headroom over a 1024 px JPEG frame; reject it here,
      // before any fetch.
      const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
      const decodedBytes = (payload.length * 3) / 4 - padding;
      if (decodedBytes > MAX_SAM_IMAGE_BYTES) {
        throw new Error(
          `sam: image must be at most 5 MB, got ${decodedBytes} bytes`,
        );
      }
    }
    // A non-signal passed as signal used to ride through here: a
    // string or number has no .aborted, so the aborted check below
    // passed it and the real fetch threw a bare TypeError with no
    // step name, after validation had otherwise passed. Reject a
    // present signal that is not signal-like (an object with a
    // boolean aborted) here, before any fetch, the same named-error
    // rule the request checks above follow. Null/undefined still
    // mean no signal, as before.
    if (
      req.signal !== undefined &&
      req.signal !== null &&
      (typeof req.signal !== "object" || typeof req.signal.aborted !== "boolean")
    ) {
      throw new Error("sam: signal must be an AbortSignal");
    }
    // A stopped run must not start (or pay for) a call it no
    // longer needs: an already-aborted signal throws here,
    // before any fetch, with the same AbortError name the
    // pipeline runner uses, so the route treats it as a stop,
    // not a step failure. A signal that aborts mid-flight
    // rejects the fetch below, which propagates unchanged
    // (it is not a transient 404, so no retry follows it).
    if (req.signal?.aborted) {
      const err = new Error("sam: aborted");
      err.name = "AbortError";
      throw err;
    }
    const body: Record<string, unknown> = {
      model: req.model,
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: req.concept },
            { type: "input_image", image_url: req.dataUrl },
          ],
        },
      ],
      metadata: { ...SAM_METADATA },
    };
    const started = Date.now();
    let lastStatus = 0;
    let lastDetail = "";
    for (let attempt = 0; attempt < MAX_SAM_ATTEMPTS; attempt++) {
      const res = await fetchImpl(`${baseUrl}/responses`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: req.signal,
      });
      if (res.ok) {
        const latencyMs = Date.now() - started;
        // A 200 body that is not JSON was billed at the flat
        // per-request rate like any other 200, but res.json() used
        // to throw a raw SyntaxError here, so the segment step's
        // recordFailedCall saw no costUsd and the spend was dropped
        // from the route total. Carry it like the no-text and
        // bad-token branches below.
        let parsed: Record<string, unknown>;
        try {
          parsed = (await res.json()) as Record<string, unknown>;
        } catch {
          throw new SamCallError("sam: response was not JSON", requestCost, latencyMs);
        }
        const text = extractText(parsed);
        if (text === null) {
          // The provider answered 200, so the request was billed even
          // though there is no text to parse: carry the flat cost so
          // the segment step records it instead of dropping the spend.
          throw new SamCallError("sam: response had no text output", requestCost, latencyMs);
        }
        let instances: SamInstance[];
        try {
          instances = parseSamOutput(text);
        } catch (err) {
          // Same billed-but-failed shape: preserve the parse message
          // verbatim (it already carries the "sam: " prefix) and add
          // the cost, so recordFailedCall can record the spend.
          throw new SamCallError(
            err instanceof Error ? err.message : String(err),
            requestCost,
            latencyMs,
          );
        }
        return { instances, latencyMs, costUsd: requestCost };
      }
      lastStatus = res.status;
      lastDetail = await res.text();
      // Only a 404 naming model_not_found is transient (spike, Oct 28:
      // unbilled, then 200 for the same model). Anything else throws at
      // once, as before, and so does a 404 that survives all attempts.
      const transient = res.status === 404 && lastDetail.includes("model_not_found");
      if (!transient || attempt === MAX_SAM_ATTEMPTS - 1) break;
      await sleepImpl(SAM_RETRY_DELAYS_MS[attempt] ?? 500);
    }
    throw new Error(`sam: ${lastStatus} ${lastDetail}`);
  };
}

