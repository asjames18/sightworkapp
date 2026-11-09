/**
 * Bring your own key: a Meta Model API key the user pastes in Settings, kept only in this browser.
 *
 * Rules this module keeps:
 * - The key is stored in this browser's localStorage and nowhere else. Nothing here sends it anywhere.
 * - It is never put in a URL, a log line, an error message or anything sent to /api.
 * - Only `maskKey` output is ever shown on screen after saving.
 */

export const BYOK_KEY_STORAGE = "sightwork:byok:meta:v1";

/** Shortest and longest key we accept. Real keys sit comfortably inside this range. */
export const MIN_KEY_LENGTH = 20;
export const MAX_KEY_LENGTH = 512;

/** The Settings screen and own-key runs are off until NEXT_PUBLIC_SIGHTWORK_BYOK is "on". */
export function byokEnabled(envValue: string | undefined = process.env.NEXT_PUBLIC_SIGHTWORK_BYOK): boolean {
  return envValue?.trim().toLowerCase() === "on";
}

export type KeyCheck = { ok: true; key: string } | { ok: false; reason: string };

/**
 * Tidy up what was pasted and say plainly what's wrong with it. A leading "Bearer " (copied from a curl line)
 * and surrounding quotes or spaces are dropped. The reason never repeats the key.
 */
export function checkKey(raw: string): KeyCheck {
  let key = raw.trim();
  if (/^bearer\s+/i.test(key)) key = key.replace(/^bearer\s+/i, "").trim();
  key = key.replace(/^["'`]+|["'`]+$/g, "").trim();
  if (!key) return { ok: false, reason: "Paste your Meta API key first." };
  if (/\s/.test(key)) return { ok: false, reason: "That has a space or line break in it. Copy just the key." };
  if (key.length < MIN_KEY_LENGTH) return { ok: false, reason: "That looks too short to be a Meta API key." };
  if (key.length > MAX_KEY_LENGTH) return { ok: false, reason: "That looks too long to be a Meta API key." };
  if (!/^[\x21-\x7e]+$/.test(key)) return { ok: false, reason: "That has characters a Meta API key doesn't use." };
  return { ok: true, key };
}

/** What the screen shows for a saved key: the first 4 and last 4 characters, never the middle. */
export function maskKey(key: string): string {
  if (key.length <= 12) return "••••••••";
  return `${key.slice(0, 4)}••••••••${key.slice(-4)}`;
}

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function store(): Store | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null; // storage blocked (private mode, strict settings)
  }
}

/** The saved key, or "" when there is none or the stored value no longer passes the check. */
export function loadKey(s: Store | null = store()): string {
  try {
    const raw = s?.getItem(BYOK_KEY_STORAGE);
    if (!raw) return "";
    const c = checkKey(raw);
    return c.ok ? c.key : "";
  } catch {
    return "";
  }
}

/** Save a key that passed checkKey. Returns false if this browser wouldn't keep it. */
export function saveKey(key: string, s: Store | null = store()): boolean {
  const c = checkKey(key);
  if (!c.ok || !s) return false;
  try {
    s.setItem(BYOK_KEY_STORAGE, c.key);
    return s.getItem(BYOK_KEY_STORAGE) === c.key;
  } catch {
    return false;
  }
}

/** Forget the key on this device. */
export function forgetKey(s: Store | null = store()): void {
  try {
    s?.removeItem(BYOK_KEY_STORAGE);
  } catch {
    // blocked storage had nothing saved anyway
  }
}

export function hasKey(s: Store | null = store()): boolean {
  return loadKey(s) !== "";
}
