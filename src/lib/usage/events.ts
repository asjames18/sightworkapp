// What SightWork counts, shared by the browser and the server. Every count is an anonymous daily
// total: an event name, one short detail from a fixed list, and a coarse device class. Nothing here
// can hold a name, email, IP address, access code, API key, video, narration or plan text.

export const USAGE_EVENTS = [
  "view",
  "plan_started",
  "plan_done",
  "plan_failed",
  "checkout_started",
  "checkout_done",
  "recover_used",
] as const;
export type UsageEvent = (typeof USAGE_EVENTS)[number];

/** Events the browser may send. Checkout and recovery are counted on the server only. */
export const BROWSER_EVENTS: readonly UsageEvent[] = ["view", "plan_started", "plan_done", "plan_failed"];

export const DEVICES = ["phone", "tablet", "desktop"] as const;
export type Device = (typeof DEVICES)[number];

/** Pages that are counted by name. Any other path counts as "other", so no free text is ever kept. */
export const COUNTED_PAGES = [
  "/",
  "/start",
  "/start/example",
  "/pricing",
  "/settings",
  "/help/own-key",
  "/credits",
  "/billing/done",
  "/status",
] as const;

/** How a plan ran: on the visitor's own Meta API key, or on SightWork's server with an access code. */
export const PLAN_MODES = ["byok", "code"] as const;

export function isUsageEvent(v: unknown): v is UsageEvent {
  return typeof v === "string" && (USAGE_EVENTS as readonly string[]).includes(v);
}

/** Maps a path to its counted page name. Query strings and anything after a known page are dropped. */
export function pageKey(path: unknown): string | null {
  if (typeof path !== "string" || !path.startsWith("/") || path.length > 200) return null;
  const clean = path.split(/[?#]/)[0].replace(/\/+$/, "") || "/";
  if (clean === "/admin" || clean.startsWith("/admin/")) return null;
  if (clean === "/start/example" || clean.startsWith("/start/example/")) return "/start/example";
  return (COUNTED_PAGES as readonly string[]).includes(clean) ? clean : "other";
}

/** The detail kept with an event, or null when the pair isn't one SightWork counts. */
export function usageDetail(event: UsageEvent, detail: unknown): string | null {
  switch (event) {
    case "view":
      return pageKey(detail);
    case "plan_started":
    case "plan_done":
    case "plan_failed":
      return typeof detail === "string" && (PLAN_MODES as readonly string[]).includes(detail) ? detail : null;
    case "checkout_started":
      return typeof detail === "string" && /^[a-z0-9-]{1,24}$/.test(detail) ? detail : "";
    default:
      return "";
  }
}

/** Phone, tablet or desktop from the window width alone; anything else is left blank. */
export function deviceFromWidth(width: unknown): Device | "" {
  if (typeof width !== "number" || !Number.isFinite(width) || width <= 0) return "";
  if (width < 640) return "phone";
  if (width < 1024) return "tablet";
  return "desktop";
}

export function isDevice(v: unknown): v is Device {
  return typeof v === "string" && (DEVICES as readonly string[]).includes(v);
}

/** The site's plain-language note on counting, shown in the landing page's fine print when counting is on. */
export const USAGE_NOTE =
  "We count page views, plan runs and checkouts as anonymous daily totals to see how SightWork is used. No cookies, and no names, emails, IP addresses, codes, keys, videos or plans are kept.";
