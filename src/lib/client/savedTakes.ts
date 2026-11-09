/**
 * Takes recorded in SightWork's own camera, kept on this device so a walkthrough isn't lost once the
 * page closes. The video itself is never uploaded (only frames and audio are), so before this a take
 * recorded here was gone after the run.
 *
 * Each take is kept the moment recording stops, before and apart from the upload, in IndexedDB (same
 * database and store as the saved plans, keys `take:<id>`), with a small index in localStorage so the
 * list shows at once. Only the newest TAKES_MAX are kept. Storage can be full or blocked (private mode),
 * so every call fails quietly and never throws into the recording or upload flow.
 */
export const TAKES_INDEX_KEY = "sightwork:savedTakes:v1";
export const TAKES_MAX = 3;
/** Larger takes are left to the Save video button: storing them could push out everything else. */
export const TAKE_MAX_BYTES = 600 * 1024 * 1024;
const DB_NAME = "sightwork";
const DB_STORE = "plans";
const CHANGE_EVENT = "sightwork:saved-takes";

export type TakeEntry = {
  id: string;
  /** File name as recorded, e.g. "walkthrough-2026-11-02-1240.mp4". */
  name: string;
  type: string;
  size: number;
  savedAt: string;
  durationSec: number | null;
};

type StoredTake = { blob: Blob; name: string; type: string };

/** The few IndexedDB calls this module needs, so tests can swap in a fake. */
export interface TakeStore {
  get(id: string): Promise<unknown>;
  put(id: string, value: StoredTake): Promise<void>;
  remove(id: string): Promise<void>;
}

let storeOverride: TakeStore | null | undefined;
/** Tests only: replace the IndexedDB store (null = no IndexedDB), or undefined to restore it. */
export function setTakeStoreForTests(store: TakeStore | null | undefined): void {
  storeOverride = store;
}
function store(): TakeStore | null {
  try {
    return storeOverride !== undefined ? storeOverride : indexedDbStore();
  } catch {
    return null;
  }
}

function ls(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function isEntry(v: unknown): v is TakeEntry {
  const e = v as TakeEntry | null;
  return Boolean(e && typeof e.id === "string" && e.id && typeof e.name === "string" && typeof e.savedAt === "string" && typeof e.size === "number");
}

let cachedRaw: string | null | undefined;
let cachedList: TakeEntry[] = [];
const EMPTY: TakeEntry[] = [];

/** The kept takes, newest first. Same array back while nothing changed (safe for useSyncExternalStore). */
export function listSavedTakes(): TakeEntry[] {
  let raw: string | null = null;
  try {
    raw = ls()?.getItem(TAKES_INDEX_KEY) ?? null;
  } catch {
    raw = null;
  }
  if (raw === cachedRaw) return cachedList;
  cachedRaw = raw;
  try {
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    cachedList = Array.isArray(parsed) ? parsed.filter(isEntry).slice(0, TAKES_MAX) : EMPTY;
  } catch {
    cachedList = EMPTY;
  }
  return cachedList;
}

/** Server render and first client render: nothing kept, so there's no hydration mismatch. */
export function listSavedTakesOnServer(): TakeEntry[] {
  return EMPTY;
}

function writeIndex(list: TakeEntry[]): boolean {
  try {
    const storage = ls();
    if (!storage) return false;
    if (list.length) storage.setItem(TAKES_INDEX_KEY, JSON.stringify(list));
    else storage.removeItem(TAKES_INDEX_KEY);
  } catch {
    return false;
  }
  try {
    window.dispatchEvent?.(new Event(CHANGE_EVENT));
  } catch {}
  return true;
}

/** Re-render when this tab or another one changes the list. */
export function subscribeSavedTakes(onChange: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const onStorage = (e: StorageEvent) => {
    if (!e.key || e.key === TAKES_INDEX_KEY) onChange();
  };
  window.addEventListener("storage", onStorage);
  window.addEventListener(CHANGE_EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(CHANGE_EVENT, onChange);
  };
}

/** The kept entry for this exact file (same name and size), if it's on the list. */
export function savedTakeFor(list: TakeEntry[], file: { name: string; size: number } | null | undefined): TakeEntry | null {
  if (!file) return null;
  return list.find((e) => e.name === file.name && e.size === file.size) ?? null;
}

function takeId(now: Date): string {
  return `t${now.getTime().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

function isQuota(e: unknown): boolean {
  const name = (e as { name?: string } | null)?.name ?? "";
  return name === "QuotaExceededError" || name === "NS_ERROR_DOM_QUOTA_REACHED" || /quota/i.test(String((e as Error)?.message ?? ""));
}

/**
 * Keeps one recorded take on this device, newest first (at most TAKES_MAX; older ones are deleted).
 * When storage is full, the oldest takes are cleared to make room and it tries once more. Resolves the
 * entry once stored, or null when it couldn't be kept. Never throws.
 */
export async function keepTake(file: File, opts: { durationSec?: number | null; now?: Date } = {}): Promise<TakeEntry | null> {
  try {
    const s = store();
    if (!s || !file || !(file.size > 0) || file.size > TAKE_MAX_BYTES) return null;
    const now = opts.now ?? new Date();
    const d = opts.durationSec;
    const entry: TakeEntry = {
      id: takeId(now),
      name: file.name || "walkthrough",
      type: file.type || "video/webm",
      size: file.size,
      savedAt: now.toISOString(),
      durationSec: typeof d === "number" && Number.isFinite(d) && d > 0 ? Math.round(d) : null,
    };
    const value: StoredTake = { blob: file, name: entry.name, type: entry.type };
    let before = listSavedTakes().filter((e) => e.id !== entry.id);
    try {
      await s.put(entry.id, value);
    } catch (e) {
      if (!isQuota(e) || before.length === 0) return null;
      // Full: drop the older takes first, then try once more.
      for (const old of before) await s.remove(old.id).catch(() => {});
      writeIndex([]);
      before = [];
      try {
        await s.put(entry.id, value);
      } catch {
        return null;
      }
    }
    const next = [entry, ...before].slice(0, TAKES_MAX);
    const dropped = before.slice(TAKES_MAX - 1);
    if (!writeIndex(next)) {
      void s.remove(entry.id).catch(() => {});
      return null;
    }
    for (const old of dropped) void s.remove(old.id).catch(() => {});
    return entry;
  } catch {
    return null;
  }
}

/** The kept video as a File; a row whose copy is gone or unreadable is dropped from the list. */
export async function openSavedTake(id: string): Promise<File | null> {
  let value: unknown = null;
  try {
    value = (await store()?.get(id)) ?? null;
  } catch {
    value = null;
  }
  const v = value as StoredTake | null;
  const entry = listSavedTakes().find((e) => e.id === id);
  if (v && v.blob instanceof Blob && v.blob.size > 0) {
    const name = v.name || entry?.name || "walkthrough.mp4";
    const type = v.type || v.blob.type || "video/mp4";
    try {
      return v.blob instanceof File && v.blob.name === name ? v.blob : new File([v.blob], name, { type, lastModified: Date.now() });
    } catch {
      return null;
    }
  }
  writeIndex(listSavedTakes().filter((e) => e.id !== id));
  return null;
}

/** Removes one kept take and its stored video. */
export async function removeSavedTake(id: string): Promise<void> {
  writeIndex(listSavedTakes().filter((e) => e.id !== id));
  try {
    await store()?.remove(id);
  } catch {}
}

/** What Undo needs to put a removed take back: its row, its stored video and where it sat on the list. */
export type RemovedTake = { entry: TakeEntry; stored: StoredTake; position: number };

/**
 * Removes one kept take like removeSavedTake, but first reads its stored video so Undo can put it back.
 * Resolves null when there was nothing to keep (the take was already gone or unreadable).
 */
export async function removeSavedTakeWithUndo(id: string): Promise<RemovedTake | null> {
  const list = listSavedTakes();
  const position = list.findIndex((e) => e.id === id);
  const entry = position >= 0 ? list[position] : null;
  let stored: StoredTake | null = null;
  try {
    const v = (await store()?.get(id)) as StoredTake | null | undefined;
    if (v && v.blob instanceof Blob && v.blob.size > 0) stored = v;
  } catch {
    stored = null;
  }
  await removeSavedTake(id);
  return entry && stored ? { entry, stored, position } : null;
}

/**
 * Undo for a removed take: stores its video again and puts the row back where it was (or as near as the
 * list allows). When the list has filled up again since, it resolves false rather than push another
 * take off. Resolves true once the take is listed again. Never throws.
 */
export async function restoreSavedTake(removed: RemovedTake): Promise<boolean> {
  try {
    const s = store();
    const { entry, stored } = removed ?? ({} as RemovedTake);
    if (!s || !isEntry(entry) || !(stored?.blob instanceof Blob) || !(stored.blob.size > 0)) return false;
    const rest = listSavedTakes().filter((e) => e.id !== entry.id);
    if (rest.length >= TAKES_MAX) return false;
    const at = Math.max(0, Math.min(Number.isInteger(removed.position) ? removed.position : 0, rest.length));
    try {
      await s.put(entry.id, stored);
    } catch {
      return false;
    }
    if (!writeIndex([...rest.slice(0, at), entry, ...rest.slice(at)])) {
      void s.remove(entry.id).catch(() => {});
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** "Nov 2, 12:40 PM" in the viewer's own time zone. */
export function takeWhen(savedAt: string, locale?: string): string {
  const d = new Date(savedAt);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(locale ?? "en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/** "48 MB", "1.2 GB", "900 KB". */
export function takeSize(bytes: number): string {
  if (!(bytes > 0)) return "";
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function indexedDbStore(): TakeStore | null {
  let idb: IDBFactory | undefined;
  try {
    idb = typeof indexedDB === "undefined" ? undefined : indexedDB;
  } catch {
    idb = undefined;
  }
  if (!idb) return null;
  const factory = idb;
  const open = () =>
    new Promise<IDBDatabase>((resolve, reject) => {
      const req = factory.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(DB_STORE)) req.result.createObjectStore(DB_STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error("IndexedDB blocked"));
    });
  const run = async <T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
    const db = await open();
    try {
      return await new Promise<T>((resolve, reject) => {
        const tx = db.transaction(DB_STORE, mode);
        const req = fn(tx.objectStore(DB_STORE));
        let result: T;
        req.onsuccess = () => (result = req.result);
        tx.oncomplete = () => resolve(result);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error ?? new Error("IndexedDB aborted"));
      });
    } finally {
      db.close();
    }
  };
  const key = (id: string) => `take:${id}`;
  return {
    get: (id) => run("readonly", (s) => s.get(key(id))),
    put: (id, value) => run("readwrite", (s) => s.put(value, key(id))).then(() => undefined),
    remove: (id) => run("readwrite", (s) => s.delete(key(id))).then(() => undefined),
  };
}
