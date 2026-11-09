/**
 * Where the space is: city + US state, required before a real run so the cost step can price materials
 * and labor for that area (Antonio, 2026-10-30 4:22 PM: a run with no city came back with no cost range).
 * Kept in this browser's localStorage so testers type it once. Sent as PlanRequest.region, "City, ST"
 * (the shape the server's cost step already reads, e.g. "Sebring, FL"). No network calls here.
 */
import { US_STATES, isUsStateCode } from "@/lib/regionalCost";

export { US_STATES, isUsStateCode };

export const LOCATION_KEY = "sightwork:location";

export interface RunLocation {
  city: string;
  /** Two-letter USPS code, e.g. "FL". */
  state: string;
}

export const CITY_MAX = 60;

/** Collapses spaces and trims. Keeps the tester's own capitalization. */
export function cleanCity(city: string): string {
  return city.replace(/\s+/g, " ").trim();
}

/** A city needs at least two characters with a letter in them, and no commas (they'd break "City, ST"). */
export function isValidCity(city: string): boolean {
  const c = cleanCity(city);
  return c.length >= 2 && c.length <= CITY_MAX && /\p{L}/u.test(c) && !c.includes(",");
}

export type LocationCheck =
  | { ok: true; region: string; location: RunLocation }
  | { ok: false; missing: "city" | "state" | "both"; message: string };

export const LOCATION_MESSAGES = {
  both: "Add the city and state where this space is. SightWork uses them to price the materials and labor.",
  city: "Add the city where this space is, so the cost range uses local prices.",
  state: "Pick the state where this space is, so the cost range uses local prices.",
} as const;

/** Checks both fields and builds the region string the server reads. */
export function checkLocation(loc: Partial<RunLocation> | null | undefined): LocationCheck {
  const city = cleanCity(loc?.city ?? "");
  const state = (loc?.state ?? "").trim().toUpperCase();
  const cityOk = isValidCity(city);
  const stateOk = isUsStateCode(state);
  if (!cityOk || !stateOk) {
    const missing = !cityOk && !stateOk ? "both" : !cityOk ? "city" : "state";
    return { ok: false, missing, message: LOCATION_MESSAGES[missing] };
  }
  return { ok: true, region: formatRegion(city, state), location: { city, state } };
}

export function formatRegion(city: string, state: string): string {
  return `${cleanCity(city)}, ${state.trim().toUpperCase()}`;
}

/** The saved city and state, or blanks. Never throws (storage off, bad JSON). */
export function loadLocation(): RunLocation {
  try {
    if (typeof window === "undefined") return { city: "", state: "" };
    const raw = window.localStorage.getItem(LOCATION_KEY);
    if (!raw) return { city: "", state: "" };
    const v: unknown = JSON.parse(raw);
    if (!v || typeof v !== "object") return { city: "", state: "" };
    const o = v as Record<string, unknown>;
    const city = typeof o.city === "string" ? o.city.slice(0, CITY_MAX) : "";
    const state = typeof o.state === "string" && isUsStateCode(o.state.toUpperCase()) ? o.state.toUpperCase() : "";
    return { city, state };
  } catch {
    return { city: "", state: "" };
  }
}

/** Saves what was typed (even half-filled, so nothing is lost on reload). Both blank clears it. */
export function saveLocation(loc: RunLocation): void {
  try {
    const city = loc.city.slice(0, CITY_MAX);
    const state = loc.state.trim().toUpperCase();
    if (!city.trim() && !state) window.localStorage.removeItem(LOCATION_KEY);
    else window.localStorage.setItem(LOCATION_KEY, JSON.stringify({ city, state }));
  } catch {
    /* storage off: the location just isn't remembered */
  }
}

/** "City, ST" from the saved location, or "" when it isn't complete. What a real run sends as region. */
export function loadRegion(): string {
  const c = checkLocation(loadLocation());
  return c.ok ? c.region : "";
}
