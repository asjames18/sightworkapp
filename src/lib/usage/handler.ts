// The two usage endpoints, kept apart from Next.js so they can be tested directly. Server only.
import { createHash, timingSafeEqual } from "node:crypto";
import { BROWSER_EVENTS, isDevice, isUsageEvent, usageDetail } from "./events";
import { readUsage, recordUsage, usageStore, type UsageCtx, type UsageRow } from "./store";

/** Crawlers, link previews and scripted clients aren't people using the app, so they aren't counted. */
const NOT_A_PERSON = /bot|crawl|spider|slurp|headless|lighthouse|preview|facebookexternalhit|curl|wget|python|httpclient|okhttp|go-http/i;

export type UsageHeaders = { host?: string | null; origin?: string | null; secFetchSite?: string | null; userAgent?: string | null };

/** Only this site's own pages may add to the counts. */
export function sameSite(h: UsageHeaders): boolean {
  if (h.secFetchSite && h.secFetchSite !== "same-origin") return false;
  if (h.origin) {
    try {
      if (new URL(h.origin).host !== h.host) return false;
    } catch {
      return false;
    }
  }
  return Boolean(h.secFetchSite || h.origin);
}

/** What a browser beacon would count: { e, d, v } (event, detail, device), or null to ignore it. */
export function parseBeacon(raw: string): { event: (typeof BROWSER_EVENTS)[number]; detail: string; device: "" | "phone" | "tablet" | "desktop" } | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 300) return null;
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return null;
  }
  const b = body as { e?: unknown; d?: unknown; v?: unknown } | null;
  if (!b || typeof b !== "object" || !isUsageEvent(b.e) || !BROWSER_EVENTS.includes(b.e)) return null;
  const detail = usageDetail(b.e, b.d);
  if (detail === null) return null;
  return { event: b.e, detail, device: isDevice(b.v) ? b.v : "" };
}

/** POST /api/usage. Always answers 204 with no body, counted or not, so it tells the caller nothing. */
export async function handleUsageBeacon(raw: string, headers: UsageHeaders, ctx: UsageCtx = {}): Promise<{ status: 204; counted: boolean }> {
  const env = ctx.env ?? process.env;
  if (!usageStore(env) || !sameSite(headers) || NOT_A_PERSON.test(headers.userAgent ?? "") || !headers.userAgent) return { status: 204, counted: false };
  const b = parseBeacon(raw);
  if (!b) return { status: 204, counted: false };
  return { status: 204, counted: await recordUsage(b.event, b.detail, b.device, ctx) };
}

function sameKey(given: string, expected: string): boolean {
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

export type UsageReportReply =
  | { status: 200; body: { rows: UsageRow[]; days: number } }
  | { status: 400 | 401 | 404 | 503; body: { error: string } };

/** POST /api/usage/report: { key, days } in, the daily totals out. 404 unless counting and the view key are both set up. */
export async function handleUsageReport(body: unknown, ctx: UsageCtx = {}): Promise<UsageReportReply> {
  const env = ctx.env ?? process.env;
  const expected = env.SIGHTWORK_USAGE_VIEW_TOKEN?.trim() ?? "";
  if (!usageStore(env) || expected.length < 32) return { status: 404, body: { error: "Not found." } };
  const b = body as { key?: unknown; days?: unknown } | null;
  const key = typeof b?.key === "string" ? b.key.trim() : "";
  if (!key || key.length > 200) return { status: 400, body: { error: "Enter the view key." } };
  if (!sameKey(key, expected)) return { status: 401, body: { error: "That key doesn't match." } };
  const n = typeof b?.days === "number" ? Math.floor(b.days) : 30;
  const days = Math.min(Math.max(Number.isFinite(n) ? n : 30, 1), 400);
  const rows = await readUsage(key, days, ctx);
  if (!rows) return { status: 503, body: { error: "The counts can't be read right now. Try again in a minute." } };
  return { status: 200, body: { rows, days } };
}
