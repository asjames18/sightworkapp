import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BYOK_KEY_STORAGE,
  byokEnabled,
  checkKey,
  forgetKey,
  hasKey,
  loadKey,
  maskKey,
  saveKey,
} from "../../src/lib/client/byokKey";

const KEY = "LLM_abcdefghijklmnopqrstuvwxyz0123456789";

function fakeStore(initial: Record<string, string> = {}) {
  const m = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    m,
  };
}

test("own-key settings are off unless the flag says on", () => {
  assert.equal(byokEnabled(undefined), false);
  assert.equal(byokEnabled(""), false);
  assert.equal(byokEnabled("1"), false);
  assert.equal(byokEnabled("on"), true);
  assert.equal(byokEnabled(" ON "), true);
});

test("a pasted key is tidied: spaces, quotes and a Bearer prefix go", () => {
  assert.deepEqual(checkKey(`  ${KEY}\n`), { ok: true, key: KEY });
  assert.deepEqual(checkKey(`"${KEY}"`), { ok: true, key: KEY });
  assert.deepEqual(checkKey(`Bearer ${KEY}`), { ok: true, key: KEY });
});

test("bad pastes get a plain reason that never repeats the key", () => {
  for (const raw of ["", "   ", "LLM_short", `${KEY} ${KEY}`, "x".repeat(600), `${KEY}é`]) {
    const c = checkKey(raw);
    assert.equal(c.ok, false, raw);
    if (!c.ok) {
      assert.ok(c.reason.length > 0);
      assert.ok(!c.reason.includes("LLM_"), "reason must not echo the key");
    }
  }
});

test("the mask shows only the ends", () => {
  const m = maskKey(KEY);
  assert.ok(m.startsWith("LLM_"));
  assert.ok(m.endsWith("6789"));
  assert.ok(!m.includes("abcdefgh"));
  assert.equal(maskKey("short"), "••••••••");
});

test("save, load and forget stay in this browser's storage", () => {
  const s = fakeStore();
  assert.equal(hasKey(s), false);
  assert.equal(saveKey(`  ${KEY} `, s), true);
  assert.equal(s.m.get(BYOK_KEY_STORAGE), KEY);
  assert.equal(loadKey(s), KEY);
  assert.equal(hasKey(s), true);
  forgetKey(s);
  assert.equal(loadKey(s), "");
  assert.equal(s.m.size, 0);
});

test("a bad key is not saved, and a garbled stored value reads as none", () => {
  const s = fakeStore();
  assert.equal(saveKey("nope", s), false);
  assert.equal(s.m.size, 0);
  assert.equal(loadKey(fakeStore({ [BYOK_KEY_STORAGE]: "has space in it but long enough" })), "");
});

test("blocked storage never throws", () => {
  const broken = {
    getItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {
      throw new Error("blocked");
    },
    removeItem: () => {
      throw new Error("blocked");
    },
  };
  assert.equal(loadKey(broken), "");
  assert.equal(saveKey(KEY, broken), false);
  assert.doesNotThrow(() => forgetKey(broken));
  assert.equal(loadKey(null), "");
  assert.equal(saveKey(KEY, null), false);
});
