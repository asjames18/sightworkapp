import { findResponseJson } from "../responseJson";

/**
 * SightWork Meta client (Muse Spark via the Meta Model API).
 *
 * This is the caller the pipeline steps inject (see src/lib/pipeline):
 * `reason.ts` calls it with frames attached, `cost.ts` calls it with the
 * web_search tool for grounded prices, and `renderAfter.ts` calls it for
 * the generate-2-keep-1 judge (original + two candidates, in order). The steps themselves record every
 * call on the usage tracker, so the $10 spike cap is still enforced there.
 *
 * - Base URL: https://api.meta.ai/v1 (Responses API, POST /responses).
 *   Override with opts.baseUrl or the META_API_BASE_URL env var.
 * - Key: opts.apiKey, or MODEL_API_KEY, or META_API_KEY from the
 *   environment. The key is never logged, never stored, and never sent
 *   anywhere except the Authorization header of the Meta API call.
 * - This module makes no call on import. No call happens until a caller
 *   returned here is invoked, and tests inject a fake fetch instead.
 * - Provider errors are surfaced verbatim (status + body) so a failing
 *   step fails loudly instead of guessing, per the reason step's rule.
 * - A transient 404 model_not_found is retried, up to 3 attempts with a
 *   short backoff (250 ms, then 500 ms): the Oct 28 spike showed Meta's
 *   entitlement cache serving 404s intermittently for a model that then
 *   returns 200, and those 404s are not billed, so one bad hop no longer
 *   fails the whole reason/cost/judge step. Any other error, or a 404
 *   without model_not_found, still throws at once, and a 404 that
 *   survives all 3 attempts throws with the last response. Same shape
 *   as the SAM caller's retry (src/lib/meta/sam.ts).
 * - Cost: computed from the response's usage tokens at the standard-tier
 *   rates below, which the spike wiring may override via opts. When the
 *   web_search tool is used, one search query is charged by default
 *   ($2.50 per 1,000 queries); the wiring may override that too once
 *   the provider reports a real search count. Cost is priced before
 *   the response text is parsed, so a parse failure still carries its
 *   spend on a MetaCallError for the step to record.
 */

export interface MetaUsage {
  input_tokens?: number;
  output_tokens?: number;
}

export interface MetaClientOptions {
  apiKey?: string;
  baseUrl?: string;
  /** Injectable fetch for tests. Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Injectable sleep for tests. Defaults to a real setTimeout wait. */
  sleepImpl?: (ms: number) => Promise<void>;
  /** USD per 1M input tokens. Default: standard-tier Spark pricing. */
  inputPricePerMillion?: number;
  /** USD per 1M output tokens. Default: standard-tier Spark pricing. */
  outputPricePerMillion?: number;
  /** USD charged per web_search call. Default: one query at $2.50/1,000. */
  webSearchCostUsd?: number;
}

export interface SparkCallRequest {
  model: string;
  prompt: string;
  /** Data URLs, attached in order (reason step). Omit for text-only calls. */
  images?: string[];
  /** Structured-output JSON schema (prompt 03 / 05 spec). */
  schema: Record<string, unknown>;
  /** Tool list, e.g. [{ type: "web_search" }] for the cost step. */
  tools?: { type: string }[];
  /** Sampling temperature, sent verbatim when set. Reason/review pass 0.2; other steps omit it. */
  temperature?: number;
  /**
   * Abort signal for a stopped run (2026-11-01): when set, it is
   * passed to the fetch, so stopping a run can cut the in-flight
   * Spark call short instead of only stopping before the next
   * step. An already-aborted signal throws an AbortError before
   * any fetch, so it spends nothing. Until the pipeline steps
   * pass their run signal through here, callers that omit it
   * behave exactly as before.
   */
  signal?: AbortSignal;
}

export interface SparkCallResult {
  json: unknown;
  latencyMs: number;
  costUsd: number;
}

export interface MetaClient {
  /** One Responses API call. Returns parsed JSON, latency, and cost. */
  callSpark(req: SparkCallRequest): Promise<SparkCallResult>;
}

/**
 * A Spark call that reached the provider and was billed, but whose
 * response text could not be parsed as JSON. Carries the call's
 * costUsd and latencyMs so the pipeline step can record the spend on
 * the usage tracker before failing the run — otherwise a failed parse
 * spends without any usage record and the route total under-reports
 * (the cost step's "not JSON" failure on the Oct 30 capped run did
 * exactly that). The message is identical to the plain parse errors
 * it replaces, so existing error handling matches unchanged.
 */
export class MetaCallError extends Error {
  readonly costUsd: number;
  readonly latencyMs: number;
  constructor(message: string, costUsd: number, latencyMs: number) {
    super(message);
    this.name = "MetaCallError";
    this.costUsd = costUsd;
    this.latencyMs = latencyMs;
  }
}

const DEFAULT_BASE_URL = "https://api.meta.ai/v1";
const DEFAULT_INPUT_PRICE_PER_MILLION = 1.25;
const DEFAULT_OUTPUT_PRICE_PER_MILLION = 4.25;
const DEFAULT_WEB_SEARCH_COST_USD = 0.0025;

/**
 * Most images one Spark call may carry. The reason step attaches the
 * request's frames, and the route validator caps a plan request at 48
 * frames (src/lib/pipeline/planRequest.ts MAX_PLAN_FRAMES), so every
 * call the pipeline makes today carries at most 48; the judge carries
 * exactly 3 and the cost step carries none. The tracker only sees a
 * call's cost after it returns, so without a bound here one bad direct
 * caller (say 1000 frames) would pay for all of them in a single huge
 * token bill before any cap could stop it. Forty-eight matches the
 * route cap, not a new limit on the pipeline.
 */
const MAX_SPARK_IMAGES = 48;

/** Max decoded bytes per image, same shape as the SAM and Baseten callers' 5 MB image caps. */
const MAX_SPARK_IMAGE_BYTES = 5 * 1024 * 1024;

/** Total attempts for a transient 404 model_not_found. */
const MAX_SPARK_ATTEMPTS = 3;
/** Backoff between those attempts: 250 ms after attempt 1, 500 ms after 2. */
const SPARK_RETRY_DELAYS_MS = [250, 500];

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
 * True when the string is valid base64, by the same rule the other
 * Meta callers enforce: alphabet plus up to two padding chars,
 * length a multiple of 4. Whitespace is ignored.
 */
function isBase64(value: string): boolean {
  const stripped = value.replace(/\s/g, "");
  return /^[A-Za-z0-9+/]*={0,2}$/.test(stripped) && stripped.length % 4 === 0;
}

/**
 * True when the base64 string decodes to a real image header, by the
 * same magic-byte rule the route validator uses: JPEG (FF D8 FF),
 * PNG (89 50 4E 47 0D 0A 1A 0A), GIF ("GIF87a"/"GIF89a"), or WebP
 * ("RIFF" + "WEBP" at bytes 8-11). Only the first 12 bytes are
 * decoded (the first 16 base64 chars), with atob (not Buffer) so
 * this module stays free of node types. A payload too short to hold
 * any header fails.
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

export function createMetaClient(opts: MetaClientOptions = {}): MetaClient {
  const apiKey = opts.apiKey ?? readEnv("MODEL_API_KEY") ?? readEnv("META_API_KEY");
  if (!apiKey) {
    throw new Error(
      "meta: no API key found. Set MODEL_API_KEY (or META_API_KEY) in the environment; the key is never committed or logged.",
    );
  }
  const baseUrl = (opts.baseUrl ?? readEnv("META_API_BASE_URL") ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleepImpl =
    opts.sleepImpl ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const inputPrice = opts.inputPricePerMillion ?? DEFAULT_INPUT_PRICE_PER_MILLION;
  const outputPrice = opts.outputPricePerMillion ?? DEFAULT_OUTPUT_PRICE_PER_MILLION;
  const webSearchCost = opts.webSearchCostUsd ?? DEFAULT_WEB_SEARCH_COST_USD;
  if (!Number.isFinite(inputPrice) || inputPrice < 0) {
    throw new Error(
      `meta: inputPricePerMillion must be a finite number >= 0, got ${opts.inputPricePerMillion}`,
    );
  }
  if (!Number.isFinite(outputPrice) || outputPrice < 0) {
    throw new Error(
      `meta: outputPricePerMillion must be a finite number >= 0, got ${opts.outputPricePerMillion}`,
    );
  }
  if (!Number.isFinite(webSearchCost) || webSearchCost < 0) {
    throw new Error(
      `meta: webSearchCostUsd must be a finite number >= 0, got ${opts.webSearchCostUsd}`,
    );
  }

  return {
    async callSpark(req: SparkCallRequest): Promise<SparkCallResult> {
      // A direct caller bypassing the step used to pass a non-object
      // straight through: a null request reading .model threw a bare
      // TypeError with no step name. Reject it here, before any fetch,
      // the same named-error rule the SAM, Image, Baseten, and
      // transcribe callers follow. Valid requests are unchanged.
      if (req === null || typeof req !== "object" || Array.isArray(req)) {
        throw new Error("meta: request must be an object");
      }
      // A bad request would otherwise spend a paid Spark call and only
      // fail downstream, when the step parses an empty or garbage
      // result. Reject it here, before any fetch, like the SAM, Image,
      // and ASR callers do for their request fields.
      if (typeof req.model !== "string" || req.model.trim().length === 0) {
        throw new Error("meta: model must be a non-empty string");
      }
      if (typeof req.prompt !== "string" || req.prompt.trim().length === 0) {
        throw new Error("meta: prompt must be a non-empty string");
      }
      if (
        req.images !== undefined &&
        (!Array.isArray(req.images) ||
          req.images.some((image) => typeof image !== "string" || image.trim().length === 0))
      ) {
        throw new Error("meta: images must be an array of non-empty strings");
      }
      if (req.images !== undefined && req.images.length > MAX_SPARK_IMAGES) {
        throw new Error(
          `meta: at most ${MAX_SPARK_IMAGES} images per request, got ${req.images.length}`,
        );
      }
      // Parity with the reason step's validateReasonRequest and the
      // other Meta callers (SAM, Image, Baseten): an image must be a
      // data:image base64 URL carrying a real image header. A bare
      // string, a data:text URL, garbage base64, or a text blob
      // re-labelled as an image used to pass the non-empty check here
      // and spend a paid Spark call, only to fail at the provider,
      // while the reason step already rejected the same input. A
      // direct callSpark caller gets the same fail-fast here, before
      // any fetch. Valid images still pass through unchanged.
      if (req.images !== undefined) {
        for (const image of req.images) {
          if (!image.startsWith("data:image/") || !image.includes(";base64,")) {
            throw new Error("meta: images must be data:image base64 URLs");
          }
          const payload = image.slice(image.indexOf(";base64,") + 8);
          if (payload.length === 0 || !isBase64(payload)) {
            throw new Error("meta: images must carry valid base64 image data");
          }
          if (!isImageBase64(payload)) {
            throw new Error("meta: images must carry image data (JPEG, PNG, WebP, or GIF)");
          }
          // Same shape as the SAM and Baseten callers' image caps: the
          // reason step's frames are small, but a direct caller bypassing
          // the step had no per-image byte bound, so an unbounded image
          // would ride onto a paid Spark call before any cap could stop
          // it. 5 MB decoded is wide headroom over a 1024 px JPEG frame;
          // reject it here, before any fetch.
          const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
          const decodedBytes = (payload.length * 3) / 4 - padding;
          if (decodedBytes > MAX_SPARK_IMAGE_BYTES) {
            throw new Error(
              `meta: image must be at most 5 MB, got ${decodedBytes} bytes`,
            );
          }
        }
      }
      if (req.schema === null || typeof req.schema !== "object" || Array.isArray(req.schema)) {
        throw new Error("meta: schema must be an object");
      }
      if (
        req.tools !== undefined &&
        (!Array.isArray(req.tools) ||
          req.tools.some(
            (tool) =>
              tool === null ||
              typeof tool !== "object" ||
              typeof tool.type !== "string" ||
              tool.type.trim().length === 0,
          ))
      ) {
        throw new Error("meta: tools must be an array of { type: non-empty string }");
      }
      const content: Record<string, unknown>[] = [{ type: "input_text", text: req.prompt }];
      for (const image of req.images ?? []) {
        content.push({ type: "input_image", image_url: image });
      }
      const body: Record<string, unknown> = {
        model: req.model,
        input: [{ role: "user", content }],
        text: { format: { type: "json_schema", name: "sightwork", schema: req.schema, strict: true } },
        ...(req.tools && req.tools.length > 0 ? { tools: req.tools } : {}),
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      };

      // A stopped run must not start (or pay for) a call it no
      // longer needs: an already-aborted signal throws here,
      // before any fetch, with the same AbortError name the
      // pipeline runner uses, so the route treats it as a stop,
      // not a step failure. A signal that aborts mid-flight
      // rejects the fetch below, which propagates unchanged
      // (it is not a transient 404, so no retry follows it).
      if (req.signal?.aborted) {
        const err = new Error("meta: aborted");
        err.name = "AbortError";
        throw err;
      }
      const started = Date.now();
      let parsed: Record<string, unknown> | null = null;
      let lastStatus = 0;
      let lastDetail = "";
      for (let attempt = 0; attempt < MAX_SPARK_ATTEMPTS; attempt++) {
        const res = await fetchImpl(`${baseUrl}/responses`, {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: req.signal,
        });
        if (res.ok) {
          // A 200 body that is not JSON carries no usage tokens to
          // price (Spark bills by the tokens in the body that failed
          // to parse), so it cannot be priced and keeps a plain
          // named error — res.json() used to throw a raw SyntaxError
          // here, surfacing parser internals instead of the caller
          // and the cause. The step's recordFailedCall records
          // nothing for a plain error, as for any unpriceable
          // failure, and no spend is invented. (Contrast the
          // text-parse failures below: there the body IS JSON, so
          // usage is known and the failure carries its spend on a
          // MetaCallError.)
          try {
            parsed = (await res.json()) as Record<string, unknown>;
          } catch {
            throw new Error("meta: response was not JSON");
          }
          break;
        }
        lastStatus = res.status;
        lastDetail = await res.text();
        // Only a 404 naming model_not_found is transient (spike, Oct 28:
        // unbilled, then 200 for the same model). Anything else throws at
        // once, as before, and so does a 404 that survives all attempts.
        const transient = res.status === 404 && lastDetail.includes("model_not_found");
        if (!transient || attempt === MAX_SPARK_ATTEMPTS - 1) break;
        await sleepImpl(SPARK_RETRY_DELAYS_MS[attempt] ?? 500);
      }
      if (parsed === null) {
        throw new Error(`meta: ${lastStatus} ${lastDetail}`);
      }
      const latencyMs = Date.now() - started;
      // Usage is priced BEFORE the parse, so a response whose text is
      // not JSON still carries its spend: the parse failures below are
      // MetaCallErrors with costUsd/latencyMs, for the step to record
      // on the usage tracker before failing the run. (A response with
      // both garbage text and bad token counts now throws the usage
      // error first instead of the parse error; both fail the run.)
      const usage = (parsed.usage ?? {}) as MetaUsage;
      // A bad provider token count would otherwise flow into the
      // cost math unchecked and only surface later, mid-run, when
      // the step records the call and the usage tracker rejects the
      // resulting negative (or non-finite) cost with a generic cost
      // message. Token counts are whole counts, so reject a
      // non-integer, negative, or non-finite count here, at the cost
      // computation, like the ASR caller rejects a bad duration.
      // A missing field still means zero tokens, as before.
      for (const [field, value] of [
        ["input_tokens", usage.input_tokens],
        ["output_tokens", usage.output_tokens],
      ] as const) {
        if (
          value !== undefined &&
          (typeof value !== "number" || !Number.isInteger(value) || value < 0)
        ) {
          throw new Error(`meta: usage ${field} must be an integer >= 0, got ${value}`);
        }
      }
      const inputTokens = usage.input_tokens ?? 0;
      const outputTokens = usage.output_tokens ?? 0;
      const tokenCost = (inputTokens * inputPrice + outputTokens * outputPrice) / 1_000_000;
      const searchCost = (req.tools ?? []).some((t) => t.type === "web_search") ? webSearchCost : 0;
      const costUsd = tokenCost + searchCost;
      const found = findResponseJson(parsed);
      if (!found.ok && found.text === null) throw new MetaCallError("meta: response had no text output", costUsd, latencyMs);
      if (!found.ok) throw new MetaCallError(`meta: response text was not JSON: ${(found.text ?? "").slice(0, 200)}`, costUsd, latencyMs);
      return { json: found.json, latencyMs, costUsd };
    },
  };
}

/** Adapter for the reason step's SparkCaller (frames attached). */
export function createReasonSparkCaller(client: MetaClient) {
  return (req: { model: string; prompt: string; images: string[]; schema: Record<string, unknown>; temperature?: number; signal?: AbortSignal }) =>
    client.callSpark({ model: req.model, prompt: req.prompt, images: req.images, schema: req.schema, temperature: req.temperature, signal: req.signal });
}

/** Adapter for the cost step's CostCaller (text-only, web_search tool). */
export function createCostSparkCaller(client: MetaClient) {
  return (req: { model: string; prompt: string; schema: Record<string, unknown>; signal?: AbortSignal }) =>
    client.callSpark({ model: req.model, prompt: req.prompt, schema: req.schema, tools: [{ type: "web_search" }], signal: req.signal });
}

/**
 * Judge schema for the renderAfter generate-2-keep-1 path (prompt 04's
 * judge prompt). The judge answers {"pick": 2 or 3, "reason": "..."}; the
 * step keeps the first candidate on any other answer, so the schema pins
 * pick to 2 or 3 and requires the reason.
 */
const JUDGE_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    pick: { type: "integer", enum: [2, 3] },
    reason: { type: "string" },
  },
  required: ["pick", "reason"],
  additionalProperties: false,
};

/** Adapter for the renderAfter step's JudgeCaller (original + 2 candidates, in order). */
export function createJudgeSparkCaller(client: MetaClient) {
  return (req: { model: string; prompt: string; images: [string, string, string] }) => {
    // The judge prompt's pick (2 or 3) indexes into exactly
    // [original, candidate 1, candidate 2], and callSpark only
    // checks that images are non-empty strings — so a wrong-count
    // list would otherwise spend a paid judge call whose pick no
    // longer maps to the candidates it was asked about. Reject it
    // here, before any fetch, like the other callers reject bad
    // request fields at the same point.
    if (!Array.isArray(req.images) || req.images.length !== 3) {
      throw new Error(
        `meta: judge images must be exactly 3 (original + 2 candidates), got ${Array.isArray(req.images) ? req.images.length : String(req.images)}`,
      );
    }
    return client.callSpark({
      model: req.model,
      prompt: req.prompt,
      images: [...req.images],
      schema: JUDGE_SCHEMA,
    });
  };
}
