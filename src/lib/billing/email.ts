// Email checks shared by the pricing page and the billing routes. No server-only imports, so the
// browser and the server apply exactly the same rule.

/** A plain address: one @, no spaces, quotes or angle brackets, and a dotted domain. */
export const EMAIL_PATTERN = /^[^\s@<>"',;]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;

/**
 * The address to store for a buyer: trimmed and lower-cased, so "Find my purchase" (which looks up
 * the lower-case form first) always matches it. Null when it isn't a usable address.
 */
export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const email = raw.trim().toLowerCase();
  return email.length <= 254 && EMAIL_PATTERN.test(email) ? email : null;
}
