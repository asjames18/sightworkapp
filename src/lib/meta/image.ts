/**
 * SightWork Muse Image caller (renderAfter step).
 *
 * This is the caller the renderAfter step injects (see
 * src/lib/pipeline/renderAfter.ts): one hero-frame edit per request,
 * over the Meta Responses API. The step itself records every call on
 * the usage tracker, so the $10 spike cap is still enforced there.
 *
 * - Base URL: https://api.meta.ai/v1 (Responses API, POST /responses).
 *   Override with opts.baseUrl or the META_API_BASE_URL env var.
 * - Key: opts.apiKey, or MODEL_API_KEY, or META_API_KEY from the
 *   environment. The key is never logged, never stored, and never sent
 *   anywhere except the Authorization header of the Meta API call.
 * - This module makes no call on import. No call happens until a caller
 *   returned here is invoked, and tests inject a fake fetch instead.
 * - Shape is DOCS-LEVEL, not spike-verified (spike note, Oct 26):
 *   Spark, SAM and Image still return 404 model_not_found because the
 *   team's /v1/models list is empty; only Voice Transcribe is verified
 *   live. The shape below follows the spike note's Responses variant:
 *   an input_text instruction plus the hero frame as input_image, and
 *   one completed image_generation_call per image, whose result is
 *   base64. The live spike must confirm the tool shape and the billed
 *   price before this is trusted end to end.
 * - Model ID: muse-image-1.0 (spike note). The wiring supplies it;
 *   IMAGE_MODEL is exported for that wiring, not hardcoded in the step.
 * - Options (spike note): store:false so demo frames are not kept
 *   for conversation state; size "1536x1024" for landscape frames;
 *   output_format "jpeg" so the returned data URL matches what the
 *   plan screen already renders (the provider default is webp).
 * - Cost: $0.01 per returned image, flat. Failed or safety-filtered
 *   images are free, so only completed calls are charged. When n > 1
 *   the caller makes one request per candidate and sums the cost;
 *   a short candidate list is returned, never padded with failures,
 *   and the renderAfter step picks the first good candidate when the
 *   judge path cannot run. n is capped at 4 per call, so one bad
 *   request cannot loop paid generations past the spike cap's reach.
 *   If a later candidate's request fails after an earlier candidate
 *   was billed, the throw is an ImageCallError carrying that billed
 *   cost and latency, so the step's recordFailedCall records it
 *   instead of dropping it from the route total; a failure before
 *   any billing throws the plain error, verbatim, as before.
 * - Provider errors are surfaced verbatim (status + body) so a failing
 *   step fails loudly instead of guessing, per the step's rule.
 * - A transient 404 model_not_found is retried, up to 3 attempts with a
 *   250 ms then 500 ms backoff, per candidate request: the Oct 28 spike
 *   showed those 404s are unbilled and the same model then returns
 *   200, so one bad hop no longer fails the whole picturing step. Any
 *   other error, or a 404 without model_not_found, still throws at
 *   once, and a 404 that survives all 3 attempts throws with the last
 *   response. Same shape as the Spark and SAM callers' retry.
 */

export interface ImageClientOptions {
  apiKey?: string;
  baseUrl?: string;
  /** Injectable fetch for tests. Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Injectable sleep for tests. Defaults to a real setTimeout wait. */
  sleepImpl?: (ms: number) => Promise<void>;
  /** USD charged per returned image. Default: $0.01. */
  imageCostUsd?: number;
  /** Aspect-ratio size for the generation tool. Default: "1536x1024". */
  size?: string;
  /** Data-URL media type for returned images. Default: "jpeg". */
  outputFormat?: string;
}

/** One Muse Image edit request, matching renderAfter's ImageCaller. */
export interface ImageCaller {
  (req: {
    model: string;
    prompt: string;
    /** Data URL of the hero frame to edit. */
    image: string;
    /** Candidates wanted; 1 unless the wiring asks for 2. */
    n?: number;
    /**
     * Abort signal for a stopped run (2026-11-01): when set, it is
     * passed to the fetch, and an already-aborted signal throws an
     * AbortError before any fetch, so a stopped run never starts
     * (or pays for) an image it no longer needs. Callers that omit
     * it behave exactly as before.
     */
    signal?: AbortSignal;
  }): Promise<{ images: string[]; latencyMs: number; costUsd: number }>;
}

/** Muse Image model ID, confirmed in the spike note's docs pass. */
export const IMAGE_MODEL = "muse-image-1.0";

/**
 * An Image call that was billed but failed partway through a
 * multi-candidate request: an earlier candidate completed (so its
 * $0.01 is already spent) and a later candidate's request then
 * failed. Carries the billed cost and latency so the renderAfter
 * step's recordFailedCall can record the spend instead of dropping
 * it from the route total, the same shape as
 * SamCallError/BasetenCallError/MetaCallError. Only thrown when at
 * least one image was already billed; a failure before any billing
 * keeps the plain error, verbatim, as before.
 */
export class ImageCallError extends Error {
  readonly costUsd: number;
  readonly latencyMs: number;
  constructor(message: string, costUsd: number, latencyMs: number) {
    super(message);
    this.name = "ImageCallError";
    this.costUsd = costUsd;
    this.latencyMs = latencyMs;
  }
}

const DEFAULT_BASE_URL = "https://api.meta.ai/v1";
const DEFAULT_IMAGE_COST_USD = 0.01;
const DEFAULT_SIZE = "1536x1024";
const DEFAULT_OUTPUT_FORMAT = "jpeg";

/**
 * Most candidates one call may generate. The step asks for 1 or 2
 * (generate-2-keep-1); the tracker only sees the caller's summed cost
 * after the loop, so without a bound here one bad n (say 1000) would
 * fire that many paid requests before any cap could stop it. Four
 * covers today's 1-or-2 plus headroom for a larger candidate set, and
 * bounds one call's loop spend to 4 x $0.01.
 */
const MAX_IMAGES_PER_CALL = 4;
/** Max decoded bytes for the hero frame, same shape as the SAM, Baseten and Spark callers' 5 MB image caps. */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** Total attempts for a transient 404 model_not_found. */
const MAX_IMAGE_ATTEMPTS = 3;
/** Backoff between those attempts: 250 ms after attempt 1, 500 ms after 2. */
const IMAGE_RETRY_DELAYS_MS = [250, 500];

function readEnv(name: string): string | undefined {
  try {
    const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
    const v = env?.[name];
    return v && v.trim() ? v : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Pull completed image results out of a Responses body. Only items of
 * type image_generation_call with status "completed" and a non-empty
 * result count; failed or filtered calls are free and are skipped, not
 * treated as images. Anything else in output is ignored.
 */
export function parseImageResults(body: Record<string, unknown>, outputFormat: string): string[] {
  const output = body.output;
  if (!Array.isArray(output)) return [];
  const images: string[] = [];
  for (const item of output) {
    if (item === null || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    if (rec.type !== "image_generation_call") continue;
    if (rec.status !== "completed") continue;
    const result = rec.result;
    if (typeof result !== "string" || result.length === 0) continue;
    // A "completed" call is trusted for billing but not for bytes:
    // a garbage or text result used to pass through here as a data
    // URL and only fail downstream, when the render step showed a
    // broken after-image (or handed the judge a bogus candidate).
    // Skip anything that is not valid base64 image data, by the
    // same header rule the request side enforces; the caller still
    // throws "no completed image" when nothing usable remains.
    if (!isBase64(result) || !isImageBase64(result)) continue;
    images.push(`data:image/${outputFormat};base64,${result}`);
  }
  return images;
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

export function createImageCaller(opts: ImageClientOptions = {}): ImageCaller {
  const apiKey = opts.apiKey ?? readEnv("MODEL_API_KEY") ?? readEnv("META_API_KEY");
  if (!apiKey) {
    throw new Error(
      "image: no API key found. Set MODEL_API_KEY (or META_API_KEY) in the environment; the key is never committed or logged.",
    );
  }
  const baseUrl = (opts.baseUrl ?? readEnv("META_API_BASE_URL") ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleepImpl =
    opts.sleepImpl ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const imageCost = opts.imageCostUsd ?? DEFAULT_IMAGE_COST_USD;
  // A bad per-image cost would only surface later, mid-run, when the
  // renderAfter step records the call and the usage tracker rejects
  // it. Reject it here, at caller creation, like the SAM caller does
  // for its per-request cost, so a misconfigured cost fails fast
  // before any Image call.
  if (!Number.isFinite(imageCost) || imageCost < 0) {
    throw new Error(`image: imageCostUsd must be a finite number >= 0, got ${opts.imageCostUsd}`);
  }
  const size = opts.size ?? DEFAULT_SIZE;
  const outputFormat = opts.outputFormat ?? DEFAULT_OUTPUT_FORMAT;
  // A blank or non-string size/outputFormat would otherwise be sent to
  // the provider and only fail on a paid Image call (or come back in
  // the wrong format), so reject it here, at caller creation, like the
  // per-image cost is rejected above. The bar is higher than
  // non-empty: size rides verbatim into the image_generation tool
  // params, and outputFormat rides verbatim into every returned data
  // URL (parseImageResults builds `data:image/<format>;base64,...`),
  // so a padded, punctuated, or otherwise non-token value would
  // otherwise pass creation and only surface later as a provider
  // rejection or a broken after-image data URL. Size must be the
  // documented WxH form and outputFormat a media-subtype token; the
  // defaults ("1536x1024", "jpeg") pass unchanged.
  if (typeof size !== "string" || !/^\d+x\d+$/.test(size)) {
    throw new Error(`image: size must be a WxH size like "1536x1024", got ${JSON.stringify(opts.size)}`);
  }
  if (typeof outputFormat !== "string" || !/^[A-Za-z0-9][A-Za-z0-9+.-]*$/.test(outputFormat)) {
    throw new Error(
      `image: outputFormat must be a media-subtype token like "jpeg", got ${JSON.stringify(opts.outputFormat)}`,
    );
  }

  return async (req) => {
    // A direct caller bypassing the renderAfter step used to get a raw
    // TypeError here: a null request reading .model, with no step
    // name. Fail fast with a named image error, before any fetch,
    // the same named-error rule the SAM caller follows for its
    // request. Valid requests are unchanged.
    if (req === null || typeof req !== "object" || Array.isArray(req)) {
      throw new Error("image: request must be an object");
    }
    // A bad request would otherwise spend a paid Image call and only
    // fail downstream, when the renderAfter step finds no completed
    // image. Reject it here, before any fetch, like the SAM caller
    // does for its request fields.
    if (typeof req.model !== "string" || req.model.trim().length === 0) {
      throw new Error("image: model must be a non-empty string");
    }
    if (typeof req.prompt !== "string" || req.prompt.trim().length === 0) {
      throw new Error("image: prompt must be a non-empty string");
    }
    // Parity with the segment step's validateSegmentInput and the
    // route validator: image must be a data:image base64 URL
    // carrying a real image header. A bare string, a data:text URL,
    // garbage base64, or a text blob re-labelled as an image used to
    // pass the non-empty check here and spend a paid Image call, only
    // to fail at the provider, while the route already rejected the
    // same input. A direct Image caller gets the same fail-fast here,
    // before any fetch. Valid images still pass through unchanged.
    if (typeof req.image !== "string" || req.image.trim().length === 0) {
      throw new Error("image: image must be a non-empty string");
    }
    if (!req.image.startsWith("data:image/") || !req.image.includes(";base64,")) {
      throw new Error("image: image must be a data:image base64 URL");
    }
    {
      const payload = req.image.slice(req.image.indexOf(";base64,") + 8);
      if (payload.length === 0 || !isBase64(payload)) {
        throw new Error("image: image must carry valid base64 image data");
      }
      if (!isImageBase64(payload)) {
        throw new Error("image: image must carry image data (JPEG, PNG, WebP, or GIF)");
      }
      // Same shape as the SAM/Baseten/Spark caps: the renderAfter
      // step's hero frames are small, but a direct caller bypassing
      // the step had no bound, so an unbounded hero frame would ride
      // onto a paid Image call before any cap could stop it. 5 MB
      // decoded is wide headroom over a 1024 px JPEG frame; reject
      // it here, before any fetch.
      const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
      const decodedBytes = (payload.length * 3) / 4 - padding;
      if (decodedBytes > MAX_IMAGE_BYTES) {
        throw new Error(
          `image: image must be at most 5 MB, got ${decodedBytes} bytes`,
        );
      }
    }
    const wanted = req.n ?? 1;
    if (!Number.isInteger(wanted) || wanted < 1) {
      throw new Error(`image: n must be a positive integer, got ${String(req.n)}`);
    }
    // A bad n would otherwise loop that many paid requests before
    // the usage tracker ever sees a cost: the step records the
    // caller's summed cost only after this loop returns, so the $10
    // spike cap cannot stop a runaway loop mid-call. Reject it here,
    // before any fetch, like the other request fields above. Today's
    // step asks for 1 or 2, so the bound changes no current call.
    if (wanted > MAX_IMAGES_PER_CALL) {
      throw new Error(
        `image: n must be at most ${MAX_IMAGES_PER_CALL}, got ${String(req.n)}`,
      );
    }
    // A stopped run must not start (or pay for) a call it no
    // longer needs: an already-aborted signal throws here,
    // before any fetch, with the same AbortError name the
    // pipeline runner uses, so the route treats it as a stop,
    // not a step failure. A signal that aborts mid-flight
    // rejects the fetch below, which propagates unchanged
    // (it is not a transient 404, so no retry follows it).
    if (req.signal?.aborted) {
      const err = new Error("image: aborted");
      err.name = "AbortError";
      throw err;
    }
    const images: string[] = [];
    let latencyMs = 0;
    let costUsd = 0;
    for (let i = 0; i < wanted; i++) {
      const body: Record<string, unknown> = {
        model: req.model,
        input: [
          {
            type: "message",
            role: "user",
            content: [
              { type: "input_text", text: req.prompt },
              { type: "input_image", image_url: req.image },
            ],
          },
        ],
        tools: [{ type: "image_generation", size, output_format: outputFormat }],
        store: false,
      };
      const started = Date.now();
      let parsed: Record<string, unknown> | null = null;
      let lastStatus = 0;
      let lastDetail = "";
      try {
        for (let attempt = 0; attempt < MAX_IMAGE_ATTEMPTS; attempt++) {
          const res = await fetchImpl(`${baseUrl}/responses`, {
            method: "POST",
            headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
            body: JSON.stringify(body),
            signal: req.signal,
          });
          if (res.ok) {
            // A 200 body that is not JSON carries no completed image,
            // so it cannot be priced (failed images are free) — but
            // res.json() used to throw a raw SyntaxError here,
            // surfacing parser internals instead of the caller and
            // the cause. Throw a named plain error instead; the
            // catch below still wraps it in ImageCallError when an
            // earlier candidate was already billed, so that spend
            // rides on the error for recordFailedCall.
            try {
              parsed = (await res.json()) as Record<string, unknown>;
            } catch {
              throw new Error("image: response was not JSON");
            }
            break;
          }
          lastStatus = res.status;
          lastDetail = await res.text();
          // Only a 404 naming model_not_found is transient (spike, Oct 28:
          // unbilled, then 200 for the same model). Anything else throws at
          // once, as before, and so does a 404 that survives all attempts.
          const transient = res.status === 404 && lastDetail.includes("model_not_found");
          if (!transient || attempt === MAX_IMAGE_ATTEMPTS - 1) break;
          await sleepImpl(IMAGE_RETRY_DELAYS_MS[attempt] ?? 500);
        }
      } catch (err) {
        // A fetch throw mid-request must not drop an earlier
        // candidate's billed spend: carry it, message verbatim.
        if (costUsd > 0 && err instanceof Error) {
          throw new ImageCallError(err.message, costUsd, latencyMs);
        }
        throw err;
      }
      latencyMs += Date.now() - started;
      if (parsed === null) {
        // Same rule for a failed HTTP status: an earlier billed
        // candidate's spend rides on the error for recordFailedCall.
        if (costUsd > 0) {
          throw new ImageCallError(`image: ${lastStatus} ${lastDetail}`, costUsd, latencyMs);
        }
        throw new Error(`image: ${lastStatus} ${lastDetail}`);
      }
      const found = parseImageResults(parsed, outputFormat);
      // Only completed images are billed, per the spike note.
      costUsd += found.length * imageCost;
      images.push(...found);
    }
    if (images.length === 0) {
      throw new Error("image: response had no completed image");
    }
    return { images, latencyMs, costUsd };
  };
}
