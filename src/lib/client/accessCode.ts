/**
 * Paid-plan access code for server runs. /billing/done shows the code after a purchase and keeps it in
 * this browser's localStorage; each server plan run sends it as a header, and the plan route checks its
 * signature and its Stripe status. A code typed into the code prompt is recognized by its "sw1." start.
 */
export const ACCESS_CODE_HEADER = "x-sightwork-access-code";
const KEY = "sightwork:access-code";
const MAX_LENGTH = 512;

/** True for a value shaped like a paid access code (not a check of its signature). */
export function looksLikeAccessCode(value: string): boolean {
  const v = value.trim();
  return v.startsWith("sw1.") && v.length > 4 && v.length <= MAX_LENGTH && !/\s/.test(v);
}

export function loadAccessCode(): string {
  try {
    if (typeof window === "undefined") return "";
    const v = window.localStorage.getItem(KEY) ?? "";
    return looksLikeAccessCode(v) ? v.trim() : "";
  } catch {
    return "";
  }
}

/** Saves a code shaped like an access code; anything else (or blank) clears the saved one. */
export function saveAccessCode(code: string): boolean {
  try {
    const v = code.trim();
    if (looksLikeAccessCode(v)) {
      window.localStorage.setItem(KEY, v);
      return true;
    }
    window.localStorage.removeItem(KEY);
  } catch {
    /* storage off: the code just isn't remembered */
  }
  return false;
}
