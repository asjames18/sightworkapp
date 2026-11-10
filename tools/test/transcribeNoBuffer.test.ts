/**
 * The transcribe path decodes audio without Node's Buffer, so own-key runs can include narration in the browser.
 * Runs the WAV checks with Buffer hidden from globalThis.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { validateTranscribeInput } from "@/lib/pipeline/transcribe";
import { createAsrTranscribeCaller } from "@/lib/meta/transcribe";
import { readFileSync } from "node:fs";

function wav(opts: { channels?: number; rate?: number; bits?: number } = {}): string {
  const { channels = 1, rate = 16000, bits = 16 } = opts;
  const data = new Uint8Array(3200);
  const out = new Uint8Array(44 + data.length);
  const v = new DataView(out.buffer);
  const put = (o: number, t: string) => { for (let i = 0; i < t.length; i++) out[o + i] = t.charCodeAt(i); };
  put(0, "RIFF"); v.setUint32(4, 36 + data.length, true); put(8, "WAVE");
  put(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, channels, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * channels * bits / 8, true); v.setUint16(32, channels * bits / 8, true); v.setUint16(34, bits, true);
  put(36, "data"); v.setUint32(40, data.length, true);
  let s = ""; for (const b of out) s += String.fromCharCode(b);
  return btoa(s);
}

async function withoutBuffer<T>(fn: () => T | Promise<T>): Promise<T> {
  const g = globalThis as { Buffer?: unknown };
  const saved = g.Buffer;
  delete g.Buffer;
  try { return await fn(); } finally { g.Buffer = saved; }
}

describe("transcribe without Node Buffer", () => {
  test("the source files no longer use Buffer", () => {
    for (const f of ["src/lib/pipeline/transcribe.ts", "src/lib/meta/transcribe.ts"]) {
      const code = readFileSync(f, "utf8").split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
      assert.doesNotMatch(code, /\bBuffer\./, f);
    }
  });

  test("a mono 16-bit WAV passes the input checks with no Buffer present", async () => {
    await withoutBuffer(() => {
      const ok = (() => { try { validateTranscribeInput({ audioWavBase64: wav() } as never); return "ok"; } catch (e) { return (e as Error).message; } })();
      assert.doesNotMatch(ok, /Buffer is not defined/);
      assert.doesNotMatch(ok, /not a WAV file/);
    });
  });

  test("a non-WAV payload is still refused with no Buffer present", async () => {
    await withoutBuffer(() => {
      assert.throws(() => validateTranscribeInput({ audioWavBase64: btoa("PNGPNGPNGPNGPNGPNG") } as never), /not a WAV file/);
    });
  });

  test("the ASR caller rejects non-WAV before any fetch, with no Buffer present", async () => {
    let calls = 0;
    const call = createAsrTranscribeCaller({ apiKey: "k", fetchImpl: (async () => { calls++; return new Response("{}"); }) as typeof fetch } as never);
    await withoutBuffer(async () => {
      await assert.rejects(() => call({ model: "m", mode: "standard", audioWavBase64: btoa("PNGPNGPNGPNGPNGPNG") } as never), /RIFF\/WAVE/);
    });
    assert.equal(calls, 0);
  });
});
