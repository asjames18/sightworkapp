/**
 * SightWork Baseten caller (Muse Spark Open, the main plan engine).
 *
 * Per Antonio's Oct 27 decision, the reason step's main engine is
 * Muse Spark Open on Baseten; Meta SAM 3.1 / Muse Image stay optional
 * steps that skip cleanly when Meta is blocked. This module is the
 * Baseten counterpart of ./client.ts (the Meta caller): same request /
 * result shape, so the pipeline steps can swap providers without
 * changing step logic. The route picks the provider later
 * (PLAN_PROVIDER=baseten|meta); this module only makes the call.
 *
 * - Base URL: https://inference.baseten.co/v1 (OpenAI-compatible
 *   Chat Completions, POST /chat/completions). Override with
 *   opts.baseUrl or the BASETEN_API_BASE_URL env var.
 * - Model: exactly "meta-models/muse-spark-open-1026". The hackathon
 *   key works with this model only (the docs' bare
 *   "meta-models/muse-spark-open" name is NOT the hackathon model), so
 *   the caller always uses its configured model and ignores any model
 *   name passed on a request.
 * - Key: opts.apiKey, or BASETEN_API_KEY from the environment. The key
 *   is never logged, never stored, and never sent anywhere except the
 *   Authorization header of the Baseten call.
 * - This module makes no call on import. No call happens until a caller
 *   returned here is invoked, and tests inject a fake fetch instead.
 * - Provider limits that shape this caller (spike notes, Oct 27):
 *   at most 8 images per request, each at most 5 MB decoded (a direct
 *   caller cannot push an unbounded frame onto a paid call); the JSON
 *   schema is NOT enforced server-side, so the schema is appended to
 *   the prompt text, the
 *   reasoning lane (returned separately from message.content) is
 *   ignored, code fences are stripped, and the parsed content is
 *   returned for the step's own validation + one retry.
 * - Cost: computed from the response's usage tokens at $1.25/M input
 *   and $4.25/M output (spike-measured: 8,812 in / 2,805 out = $0.0229).
 *   Usage is priced BEFORE the answer text is parsed, mirroring
 *   ./client.ts: a response whose text is not JSON, or that has no
 *   text at all, still spent its tokens, so those failures throw
 *   BasetenCallError carrying costUsd/latencyMs for the pipeline step
 *   to record (recordFailedCall in ../pipeline/usage.ts), instead of
 *   a plain error that drops the spend from the route total.
 *   Provider errors are surfaced verbatim (status + body) so a failing
 *   step fails loudly instead of guessing.
 * - A transient 404 model_not_found is retried, up to 3 attempts with a
 *   short backoff (250 ms, then 500 ms), mirroring the Meta callers.
 *   Transient gateway failures (502, 503, 504) retry the same way,
 *   with a longer backoff (1 s, then 2 s): the Oct 30 real run hit a
 *   Baseten 504 "authentication service request timed out" at the
 *   comparing step while the status page was all green, and that
 *   error used to fail the run at once. A failed 5xx carries no
 *   usage tokens, so a retry spends nothing extra; the spike cap
 *   still applies to every successful call via the tracker. Any
 *   other error, or a transient error surviving all 3 attempts,
 *   still throws with the last response.
 */

export interface BasetenClientOptions {
  apiKey?: string;
  baseUrl?: string;
  /** Injectable fetch for tests. Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Injectable sleep for tests. Defaults to a real setTimeout wait. */
  sleepImpl?: (ms: number) => Promise<void>;
  /** Fixed model for every call. Default: the hackathon model below. */
  model?: string;
  /** USD per 1M input tokens. Default: Baseten Muse Spark Open pricing. */
  inputPricePerMillion?: number;
  /** USD per 1M output tokens. Default: Baseten Muse Spark Open pricing. */
  outputPricePerMillion?: number;
}

export interface BasetenCallRequest {
  /** Ignored: the caller always uses its configured model (see header). */
  model: string;
  prompt: string;
  /** Data URLs, attached in order (reason step). At most 8. */
  images?: string[];
  /** JSON schema, appended to the prompt (not enforced server-side). */
  schema: Record<string, unknown>;
  /** Sampling temperature, sent verbatim when set. Reason/review pass 0.2; other steps omit it. */
  temperature?: number;
  /**
   * Abort signal for a stopped run (2026-11-01): when set, it is
   * passed to the fetch, so stopping a run can cut the in-flight
   * Baseten call short instead of only stopping before the next
   * step. An already-aborted signal throws an AbortError before
   * any fetch, so it spends nothing. Until the pipeline steps
   * pass their run signal through here, callers that omit it
   * behave exactly as before.
   */
  signal?: AbortSignal;
}

export interface BasetenCallResult {
  json: unknown;
  latencyMs: number;
  costUsd: number;
  /** Model actually used for the call (the configured model). */
  model: string;
}

export interface BasetenClient {
  /** One Chat Completions call. Returns parsed JSON, latency, cost, and the model used. */
  callSpark(req: BasetenCallRequest): Promise<BasetenCallResult>;
}

/**
 * A Baseten call that failed AFTER billing, e.g. a 200 response whose
 * answer text is not JSON. Mirrors MetaCallError in ./client.ts: it
 * carries the call's costUsd/latencyMs so the pipeline step can record
 * the spend on the usage tracker before failing the run, instead of
 * silently dropping it from the route total. Duck-typed by
 * recordFailedCall, not instanceof-checked, like the Meta error.
 */
export class BasetenCallError extends Error {
  readonly costUsd: number;
  readonly latencyMs: number;
  /** Model that ran the call, when the caller knew it (the configured model). */
  readonly model?: string;
  constructor(message: string, costUsd: number, latencyMs: number, model?: string) {
    super(message);
    this.name = "BasetenCallError";
    this.costUsd = costUsd;
    this.latencyMs = latencyMs;
    if (typeof model === "string" && model.trim().length > 0) this.model = model;
  }
}

const DEFAULT_BASE_URL = "https://inference.baseten.co/v1";
const BASETEN_MODEL = "meta-models/muse-spark-open-1026";
const MAX_IMAGES_PER_REQUEST = 8;
/** Max decoded bytes per image. Frames are 1024 px JPEGs (tools/frames/sample-frames.mjs), so 5 MB leaves wide headroom while bounding a direct caller that bypasses the step, the same shape as the ASR caller's 32 MB audio cap. */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const DEFAULT_INPUT_PRICE_PER_MILLION = 1.25;
const DEFAULT_OUTPUT_PRICE_PER_MILLION = 4.25;
/** Total attempts for a transient 404 model_not_found. */
const MAX_BASETEN_ATTEMPTS = 3;
/** Backoff between those attempts: 250 ms after attempt 1, 500 ms after 2. */
const BASETEN_RETRY_DELAYS_MS = [250, 500];
/** Gateway statuses treated as transient (see header): a 504 auth-service
 *  timeout, or a 502/503 from a hop in front of Baseten, clears on retry. */
const TRANSIENT_GATEWAY_STATUSES = [502, 503, 504];
/** Backoff after a transient gateway failure: longer than the 404 hop
 *  backoff, so an auth service that just timed out has time to recover. */
const GATEWAY_RETRY_DELAYS_MS = [1000, 2000];

function readEnv(name: string): string | undefined {
  try {
    const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
    const v = env?.[name];
    return v && v.trim() ? v : undefined;
  } catch {
    return undefined;
  }
}

/** Strip a surrounding ``` or ```json fence; plain text passes through. */
export function stripCodeFences(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("```")) return trimmed;
  const lines = trimmed.split("\n");
  lines.shift();
  if (lines.length > 0 && lines[lines.length - 1].trim() === "```") lines.pop();
  return lines.join("\n").trim();
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

export function createBasetenClient(opts: BasetenClientOptions = {}): BasetenClient {
  const apiKey = opts.apiKey ?? readEnv("BASETEN_API_KEY");
  if (!apiKey) {
    throw new Error(
      "baseten: no API key found. Set BASETEN_API_KEY in the environment; the key is never committed or logged.",
    );
  }
  const baseUrl = (opts.baseUrl ?? readEnv("BASETEN_API_BASE_URL") ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  const model = opts.model ?? BASETEN_MODEL;
  // A blank or non-string configured model would otherwise be sent to
  // Baseten and only fail at the provider, spending a paid call: the
  // request's model is deliberately ignored (this caller always uses
  // its configured model), so the configured model is the one that
  // must be checked. Reject it here, at caller creation, like the
  // token prices below, so a misconfigured model fails fast before
  // any Baseten call. The default hackathon model is unchanged.
  if (typeof model !== "string" || model.trim().length === 0) {
    throw new Error(`baseten: model must be a non-empty string, got ${JSON.stringify(opts.model)}`);
  }
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleepImpl =
    opts.sleepImpl ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const inputPrice = opts.inputPricePerMillion ?? DEFAULT_INPUT_PRICE_PER_MILLION;
  const outputPrice = opts.outputPricePerMillion ?? DEFAULT_OUTPUT_PRICE_PER_MILLION;
  if (!Number.isFinite(inputPrice) || inputPrice < 0) {
    throw new Error(
      `baseten: inputPricePerMillion must be a finite number >= 0, got ${opts.inputPricePerMillion}`,
    );
  }
  if (!Number.isFinite(outputPrice) || outputPrice < 0) {
    throw new Error(
      `baseten: outputPricePerMillion must be a finite number >= 0, got ${opts.outputPricePerMillion}`,
    );
  }

  return {
    async callSpark(req: BasetenCallRequest): Promise<BasetenCallResult> {
      // A direct caller bypassing the step used to pass a non-object
      // straight through: a null request reading .prompt threw a bare
      // TypeError with no step name. Reject it here, before any fetch,
      // the same named-error rule the SAM, Image, and transcribe
      // callers follow. Valid requests are unchanged.
      if (req === null || typeof req !== "object" || Array.isArray(req)) {
        throw new Error("baseten: request must be an object");
      }
      // A bad request would otherwise spend a paid Baseten call and only
      // fail downstream, when the step parses an empty or garbage
      // result. Reject it here, before any fetch, mirroring the Meta
      // caller's request-field validation. The request's model is
      // deliberately not checked: this caller always uses its
      // configured model and ignores any model name on the request.
      if (typeof req.prompt !== "string" || req.prompt.trim().length === 0) {
        throw new Error("baseten: prompt must be a non-empty string");
      }
      if (
        req.images !== undefined &&
        (!Array.isArray(req.images) ||
          req.images.some((image) => typeof image !== "string" || image.trim().length === 0))
      ) {
        throw new Error("baseten: images must be an array of non-empty strings");
      }
      // Parity with the reason step's validateReasonRequest and the
      // route validator: an image must be a data:image base64 URL
      // carrying a real image header. A bare string, a data:text URL,
      // garbage base64, or a text blob re-labelled as an image used to
      // pass the non-empty check here and spend a paid Baseten call,
      // only to fail at the provider, while the reason step already
      // rejected the same input. A direct Baseten caller gets the same
      // fail-fast here, before any fetch. Valid images still pass
      // through unchanged.
      if (req.images !== undefined) {
        for (const image of req.images) {
          if (!image.startsWith("data:image/") || !image.includes(";base64,")) {
            throw new Error("baseten: images must be data:image base64 URLs");
          }
          const payload = image.slice(image.indexOf(";base64,") + 8);
          if (payload.length === 0 || !isBase64(payload)) {
            throw new Error("baseten: images must carry valid base64 image data");
          }
          if (!isImageBase64(payload)) {
            throw new Error("baseten: images must carry image data (JPEG, PNG, WebP, or GIF)");
          }
          // Same shape as the ASR caller's audio cap: the step's frames
          // are small, but a direct caller bypassing the step had no
          // bound, so an unbounded frame would ride onto a paid call
          // before any cap could stop it. 5 MB decoded is wide
          // headroom over a 1024 px JPEG frame; reject it here,
          // before any fetch.
          const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
          const decodedBytes = (payload.length * 3) / 4 - padding;
          if (decodedBytes > MAX_IMAGE_BYTES) {
            throw new Error(
              `baseten: image must be at most 5 MB, got ${decodedBytes} bytes`,
            );
          }
        }
      }
      if (req.schema === null || typeof req.schema !== "object" || Array.isArray(req.schema)) {
        throw new Error("baseten: schema must be an object");
      }
      const images = req.images ?? [];
      if (images.length > MAX_IMAGES_PER_REQUEST) {
        throw new Error(
          `baseten: at most ${MAX_IMAGES_PER_REQUEST} images per request, got ${images.length}`,
        );
      }
      const content: Record<string, unknown>[] = [
        {
          type: "text",
          // Schema is not enforced server-side: it rides in the prompt
          // and the step validates the parsed JSON itself.
          text:
            `${req.prompt}\n\nReturn only a JSON object matching this JSON schema, with no other text:\n${JSON.stringify(req.schema)}`,
        },
      ];
      for (const image of images) {
        content.push({ type: "image_url", image_url: { url: image } });
      }
      const body: Record<string, unknown> = {
        model,
        messages: [{ role: "user", content }],
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      };

      // A stopped run must not start (or pay for) a call it no
      // longer needs: an already-aborted signal throws here,
      // before any fetch, with the same AbortError name the
      // pipeline runner uses, so the route treats it as a stop,
      // not a step failure. A signal that aborts mid-flight
      // rejects the fetch below, which propagates unchanged
      // (it is not a transient response, so no retry follows it).
      if (req.signal?.aborted) {
        const err = new Error("baseten: aborted");
        err.name = "AbortError";
        throw err;
      }
      const started = Date.now();
      let res: Awaited<ReturnType<typeof fetchImpl>> | undefined;
      // Mirror the Meta callers: only a 404 naming model_not_found, or a
      // transient gateway status (502/503/504), retries; any other error,
      // or a transient error surviving all attempts, throws with the last
      // response. A 504 here used to fail the comparing step at once
      // (Oct 30 real run: Baseten auth-service timeout, status green).
      for (let attempt = 0; attempt < MAX_BASETEN_ATTEMPTS; attempt++) {
        res = await fetchImpl(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: req.signal,
        });
        if (res.ok) break;
        const detail = await res.text();
        const gateway = TRANSIENT_GATEWAY_STATUSES.includes(res.status);
        const transient =
          gateway || (res.status === 404 && detail.includes("model_not_found"));
        if (!transient || attempt === MAX_BASETEN_ATTEMPTS - 1) {
          throw new Error(`baseten: ${res.status} ${detail}`);
        }
        const delays = gateway ? GATEWAY_RETRY_DELAYS_MS : BASETEN_RETRY_DELAYS_MS;
        await sleepImpl(delays[attempt] ?? 500);
      }
      if (res === undefined) {
        throw new Error("baseten: no response received");
      }
      const latencyMs = Date.now() - started;
      // A 200 body that is not JSON has no usage tokens to price:
      // unlike SAM's flat rate, Baseten bills by token, and the
      // counts live inside the body that failed to parse. So this
      // stays a plain error (the step's recordFailedCall records
      // nothing, as for any unpriceable failure), but a named one —
      // res.json() used to throw a raw SyntaxError here, surfacing
      // parser internals instead of the caller and the cause.
      let parsed: Record<string, unknown>;
      try {
        parsed = (await res.json()) as Record<string, unknown>;
      } catch {
        throw new Error("baseten: response was not JSON");
      }
      // Usage is priced BEFORE the answer text is parsed, mirroring
      // the Meta caller: a response whose text is not JSON, or that
      // has no text, still spent its tokens, and the failures below
      // throw BasetenCallError so the step records that spend. A bad
      // provider token count still throws a plain error here, at the
      // cost computation, because a bad count cannot be priced.
      const usage = (parsed.usage ?? {}) as { prompt_tokens?: number; completion_tokens?: number };
      for (const [field, value] of [
        ["prompt_tokens", usage.prompt_tokens],
        ["completion_tokens", usage.completion_tokens],
      ] as const) {
        if (
          value !== undefined &&
          (typeof value !== "number" || !Number.isInteger(value) || value < 0)
        ) {
          throw new Error(`baseten: usage ${field} must be an integer >= 0`);
        }
      }
      const inputTokens = usage.prompt_tokens ?? 0;
      const outputTokens = usage.completion_tokens ?? 0;
      const costUsd = (inputTokens * inputPrice + outputTokens * outputPrice) / 1_000_000;
      const choices = parsed.choices;
      if (!Array.isArray(choices) || choices.length === 0) {
        throw new BasetenCallError("baseten: response had no choices", costUsd, latencyMs, model);
      }
      // A null or non-object first choice used to throw a raw
      // TypeError here ("cannot read message of null") instead of
      // the clean no-text-content error below, so the step's failure
      // surfaced as an unexpected error rather than a provider
      // failure. Guard it: anything but an object choice means no
      // message, and the check below throws the clean error.
      const firstChoice = choices[0];
      const message =
        firstChoice !== null && typeof firstChoice === "object"
          ? (firstChoice as Record<string, unknown>).message as
              | Record<string, unknown>
              | undefined
          : undefined;
      // Reasoning arrives in its own lane (e.g. reasoning_content); only
      // message.content is the answer, and only that is parsed.
      const text = message?.content;
      if (typeof text !== "string") {
        throw new BasetenCallError("baseten: response message had no text content", costUsd, latencyMs, model);
      }
      let json: unknown;
      try {
        json = JSON.parse(stripCodeFences(text));
      } catch {
        throw new BasetenCallError(
          `baseten: response text was not JSON: ${text.slice(0, 200)}`,
          costUsd,
          latencyMs,
          model,
        );
      }
      return { json, latencyMs, costUsd, model };
    },
  };
}

/** Adapter for the reason step's SparkCaller (frames attached). */
export function createReasonBasetenCaller(client: BasetenClient) {
  return (req: { model: string; prompt: string; images: string[]; schema: Record<string, unknown>; temperature?: number; signal?: AbortSignal }) =>
    client.callSpark({ model: req.model, prompt: req.prompt, images: req.images, schema: req.schema, temperature: req.temperature, signal: req.signal });
}
