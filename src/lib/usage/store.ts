// Where the counts live. Server only.
//
// A Postgres table of daily totals (one row per day, site, event, detail and device class), reached
// through two database functions: one adds 1 to a counter, the other reads the totals back for someone
// holding the view key. The database deletes rows older than 400 days. No request, visitor or session is
// ever stored, so there is nothing to link one count to another.
import type { Device, UsageEvent } from "./events";

type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export type UsageCtx = { env?: Record<string, string | undefined>; fetchImpl?: FetchLike };

export type UsageRow = { day: string; site: "production" | "preview"; event: string; detail: string; device: string; count: number };

/** The store's address and public key, or null when counting is off (both must be set). */
export function usageStore(env: Record<string, string | undefined>): { url: string; key: string } | null {
  const url = env.SIGHTWORK_USAGE_URL?.trim().replace(/\/+$/, "") ?? "";
  const key = env.SIGHTWORK_USAGE_KEY?.trim() ?? "";
  if (!/^https:\/\/[a-z0-9.-]+$/i.test(url) || !/^[A-Za-z0-9._-]{20,400}$/.test(key)) return null;
  return { url, key };
}

/** "production" on the live site, "preview" everywhere else, so test traffic never mixes into the real numbers. */
export function usageSite(env: Record<string, string | undefined>): "production" | "preview" {
  return env.VERCEL_ENV === "production" ? "production" : "preview";
}

async function rpc(name: string, args: Record<string, unknown>, ctx: UsageCtx, timeoutMs: number): Promise<unknown> {
  const env = ctx.env ?? process.env;
  const store = usageStore(env);
  if (!store) return null;
  const f = ctx.fetchImpl ?? (fetch as unknown as FetchLike);
  const res = await f(`${store.url}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: { apikey: store.key, Authorization: `Bearer ${store.key}`, "Content-Type": "application/json" },
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`usage store answered ${res.status}`);
  return res.json();
}

/** Adds 1 to today's counter. Never throws: a counting blip must not touch the page or payment it rides on. */
export async function recordUsage(event: UsageEvent, detail: string, device: Device | "", ctx: UsageCtx = {}): Promise<boolean> {
  const env = ctx.env ?? process.env;
  if (!usageStore(env)) return false;
  try {
    await rpc("sightwork_usage_bump", { p_site: usageSite(env), p_event: event, p_detail: detail, p_device: device }, ctx, 2000);
    return true;
  } catch {
    return false;
  }
}

/** The daily totals for the last `days` days, newest first. The database checks the view key itself too. */
export async function readUsage(token: string, days: number, ctx: UsageCtx = {}): Promise<UsageRow[] | null> {
  try {
    const out = await rpc("sightwork_usage_read", { p_token: token, p_days: days }, ctx, 8000);
    if (!Array.isArray(out)) return null;
    return out.flatMap((r) => {
      const row = r as Record<string, unknown>;
      const count = Number(row.count);
      if (typeof row.day !== "string" || typeof row.event !== "string" || !Number.isSafeInteger(count)) return [];
      return [{
        day: row.day,
        site: row.site === "production" ? "production" : "preview",
        event: row.event,
        detail: typeof row.detail === "string" ? row.detail : "",
        device: typeof row.device === "string" ? row.device : "",
        count,
      } satisfies UsageRow];
    });
  } catch {
    return null;
  }
}
