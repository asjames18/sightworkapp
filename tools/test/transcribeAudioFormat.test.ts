/** validateTranscribeInput checks the WAV format up front, so the transcribe route answers 400 (not 500) for bad audio. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_AUDIO_BYTES, validateTranscribeInput } from "@/lib/pipeline/transcribe";
import { POST } from "../../src/app/api/transcribe/route";

/** A tiny PCM WAV: 44-byte header plus a few silent samples. */
function wav(opts: { channels?: number; sampleRate?: number; bits?: number; format?: number } = {}): string {
  const channels = opts.channels ?? 1;
  const sampleRate = opts.sampleRate ?? 16000;
  const bits = opts.bits ?? 16;
  const data = Buffer.alloc(32);
  const h = Buffer.alloc(44);
  h.write("RIFF", 0, "ascii");
  h.writeUInt32LE(36 + data.length, 4);
  h.write("WAVE", 8, "ascii");
  h.write("fmt ", 12, "ascii");
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(opts.format ?? 1, 20);
  h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE((sampleRate * channels * bits) / 8, 28);
  h.writeUInt16LE((channels * bits) / 8, 32);
  h.writeUInt16LE(bits, 34);
  h.write("data", 36, "ascii");
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]).toString("base64");
}

/** A RIFF/WAVE header whose first chunk is not fmt (fmt is out of the decoded head). */
function wavWithoutFmtInHead(): string {
  const h = Buffer.alloc(12 + 8 + 400);
  h.write("RIFF", 0, "ascii");
  h.writeUInt32LE(h.length - 8, 4);
  h.write("WAVE", 8, "ascii");
  h.write("LIST", 12, "ascii");
  h.writeUInt32LE(400, 16);
  return h.toString("base64");
}

const FORMAT = /^transcribe: audio must be mono s16le WAV at 16000 or 24000 Hz/;
const HEADER = "transcribe: audio is not a WAV file (missing RIFF/WAVE header)";

test("mono 16-bit WAV at 16000 and 24000 Hz passes", () => {
  assert.doesNotThrow(() => validateTranscribeInput({ audioWavBase64: wav({ sampleRate: 16000 }) }));
  assert.doesNotThrow(() => validateTranscribeInput({ audioWavBase64: wav({ sampleRate: 24000 }), spaceType: "sanctuary" }));
});

test("empty or absent audio means no narration and passes", () => {
  assert.doesNotThrow(() => validateTranscribeInput({ audioWavBase64: "" }));
  assert.doesNotThrow(() => validateTranscribeInput({}));
});

test("stereo, 8 kHz, 8-bit and float WAVs fail with the format message", () => {
  assert.throws(() => validateTranscribeInput({ audioWavBase64: wav({ channels: 2 }) }), { message: FORMAT });
  assert.throws(() => validateTranscribeInput({ audioWavBase64: wav({ sampleRate: 8000 }) }), { message: FORMAT });
  assert.throws(() => validateTranscribeInput({ audioWavBase64: wav({ bits: 8 }) }), { message: FORMAT });
  assert.throws(() => validateTranscribeInput({ audioWavBase64: wav({ format: 3, bits: 32 }) }), { message: FORMAT });
});

test("non-WAV base64 and a too-short payload fail with the header message", () => {
  const notWav = Buffer.from("this is plain text, not audio at all, long enough").toString("base64");
  assert.throws(() => validateTranscribeInput({ audioWavBase64: notWav }), { message: HEADER });
  assert.throws(() => validateTranscribeInput({ audioWavBase64: Buffer.from("RIFF").toString("base64") }), { message: HEADER });
});

test("a non-base64 string fails with the base64 message", () => {
  assert.throws(() => validateTranscribeInput({ audioWavBase64: "not base64 !!!" }), {
    message: "transcribe: audioWavBase64 is not valid base64",
  });
});

test("audio over the 32 MB step cap fails before decoding", () => {
  const over = "A".repeat(((MAX_AUDIO_BYTES + 1) / 3) * 4); // 32 MB + 1 byte decoded, valid base64 length
  assert.throws(() => validateTranscribeInput({ audioWavBase64: over }), { message: /is 33554433 bytes, over the 33554432 byte limit/ });
});

test("a WAV with no fmt chunk in the decoded head passes (left to the provider)", () => {
  assert.doesNotThrow(() => validateTranscribeInput({ audioWavBase64: wavWithoutFmtInHead() }));
});

test("blank, non-string audio and a blank spaceType keep their own messages", () => {
  assert.throws(() => validateTranscribeInput({ audioWavBase64: "   " }), {
    message: "transcribe: audioWavBase64 must not be blank when given",
  });
  assert.throws(() => validateTranscribeInput({ audioWavBase64: 42 as unknown as string }), {
    message: "transcribe: audioWavBase64 is not a string",
  });
  assert.throws(() => validateTranscribeInput({ audioWavBase64: wav(), spaceType: " " }), {
    message: "transcribe: spaceType is not a non-empty string",
  });
});

test("POST /api/transcribe: stereo audio gets a 400 with zero fetches", async () => {
  const real = globalThis.fetch;
  const realError = console.error;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    throw new Error("fetch must not be called");
  }) as typeof fetch;
  console.error = () => {};
  try {
    const res = await POST(
      new Request("http://localhost/api/transcribe", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ audioWavBase64: wav({ channels: 2 }) }),
      }),
    );
    assert.equal(res.status, 400);
  } finally {
    globalThis.fetch = real;
    console.error = realError;
  }
  assert.equal(calls, 0);
});
