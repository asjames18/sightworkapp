/**
 * SightWork plan-request validation.
 *
 * Pure checks for the JSON body POSTed to /api/plan, run before any
 * pipeline step so a malformed body fails fast on "uploading" with a
 * plain message instead of halfway through a model run. Shape only:
 * it does not judge whether the frames or audio will produce a good
 * plan (an empty frames array is rejected here, before any model
 * call is spent on a run that cannot produce a plan). No API calls, no keys, and no
 * provider text in the problems it returns.
 */

/** Agreed route cap: the browser builder stays under 9 MB, the route rejects over 10 MB. */
export const MAX_PLAN_BODY_BYTES = 10 * 1024 * 1024;

/**
 * Agreed frame cap: the browser builder sends at most 48 frames
 * (prompt 02, under the 50-images-per-request limit), so a request
 * over 48 is not something the UI produces. Rejecting it here fails
 * fast on "uploading" before any model call is spent on a run that
 * would blow the spike cap mid-pipeline.
 */
export const MAX_PLAN_FRAMES = 48;

/**
 * Max decoded bytes per plan frame, same bound as the reason,
 * segment, runPlan, and renderAfter step caps and the Spark, SAM,
 * Baseten, and Image caller caps. Frames are 1024 px JPEGs from the
 * browser builder, so 5 MB is wide headroom; a larger frame is not
 * something the UI produces.
 */
export const MAX_PLAN_FRAME_IMAGE_BYTES = 5 * 1024 * 1024;

/**
 * True when the raw request text is over the route body cap. A
 * non-string body from a direct caller used to be silently coerced:
 * TextEncoder.encode stringifies its argument, so an object became
 * "[object Object]" (15 bytes) and passed the cap, and the route then
 * JSON-parsed that string instead of the real body. Reject a
 * non-string here with a named error, the same named-error rule the
 * other pipeline guards follow. The route caller is unchanged: it
 * always passes req.text(), a string.
 */
export function planBodyTooLarge(bodyText: string): boolean {
  if (typeof bodyText !== "string") {
    throw new Error(
      `planRequest: bodyText must be a string, got ${JSON.stringify(bodyText) ?? typeof bodyText}`,
    );
  }
  return new TextEncoder().encode(bodyText).length > MAX_PLAN_BODY_BYTES;
}

/**
 * Problems with a parsed /api/plan body; [] = valid. Follows the
 * checkWorkPlan convention (a list, not a throw) so the route can map
 * the first problem to a plain failure message. Frames must also be
 * in walkthrough order (non-decreasing tSec): the reason subset
 * picks evenly spaced frames by position, so an out-of-order request
 * would silently mislabel times and subset positions. Each frame's
 * dataUrl must be a data:image base64 URL with a valid base64 payload:
 * the browser builder sends canvas JPEG data URLs, and a bare data:image
 * string (or a non-image string) would otherwise pass here and only
 * surface later, when the segment step skips and the plan silently loses
 * segmentation. A garbage payload would pass the prefix check the same
 * way, so the payload is checked with the same base64 rule as audio.
 * Valid base64 alone is still not an image: a text blob re-labelled
 * data:image/jpeg would pass the base64 check and only surface later,
 * when the segment step rejects it and the plan silently loses
 * segmentation. So the payload must also decode to a real image
 * header (JPEG, PNG, WebP, or GIF, the formats a canvas can produce).
 * A frame's tSec must not exceed
 * durationSec: the browser builder samples frames from the video
 * itself, so a later timestamp would mislabel that proof frame's
 * time on the plan screen. audioWavBase64 must be valid base64 when
 * present: the transcribe step rejects anything else, so a malformed
 * string would otherwise fail the run at "listening" instead of here
 * on "uploading", before any model call is spent. It must also carry
 * a WAV header: the transcribe step throws on a non-WAV payload with
 * the same RIFF/WAVE rule, so a valid-base64 MP3 (or any other blob)
 * would otherwise pass here and fail at "listening" instead of here
 * on "uploading". A whitespace-only string is rejected outright: the
 * transcribe step treats any non-empty string as audio, so blank audio
 * would otherwise pass here (it strips to empty, which the base64 and
 * WAV checks both accept as "no audio") and fail at "listening".
 * Finally the fmt chunk must be mono s16le at 16000 or 24000 Hz:
 * Meta transcribe rejects anything else (8 kHz got a 400 on
 * 2026-10-28), so an unsupported rate would otherwise fail the run
 * at "listening" instead of here on "uploading".
 */

/**
 * True when the string is valid base64, by the same rule the
 * transcribe step enforces (src/lib/pipeline/transcribe.ts):
 * whitespace ignored, alphabet plus up to two padding chars, length
 * a multiple of 4. An empty string passes here because the transcribe
 * step treats it as no audio, not as malformed audio.
 */
function isBase64(value: string): boolean {
  const stripped = value.replace(/\s/g, "");
  return /^[A-Za-z0-9+/]*={0,2}$/.test(stripped) && stripped.length % 4 === 0;
}

/**
 * True when the base64 string decodes to a WAV header, by the same
 * rule the transcribe step enforces (src/lib/pipeline/transcribe.ts):
 * the first four bytes are "RIFF" and bytes 8-11 are "WAVE". An empty
 * string passes here because the transcribe step treats it as no
 * audio, not as malformed audio. Decoded with atob (not Buffer) so
 * this pure module stays free of node types.
 */
/**
 * True when the base64 string decodes to a real image header, by
 * magic bytes: JPEG (FF D8 FF), PNG (89 50 4E 47 0D 0A 1A 0A),
 * GIF ("GIF87a"/"GIF89a"), or WebP ("RIFF" + "WEBP" at bytes 8-11).
 * Only the first 12 bytes are decoded (the first 16 base64 chars),
 * with atob (not Buffer) so this pure module stays free of node
 * types. A payload too short to hold any header fails.
 */
function isImageBase64(value: string): boolean {
  const stripped = value.replace(/\s/g, "");
  const chunk = stripped.slice(0, 16);
  if (chunk.length < 8) return false;
  const head = atob(chunk.length % 4 === 0 ? chunk : chunk.slice(0, chunk.length - (chunk.length % 4)));
  const b = (i: number): number => head.charCodeAt(i);
  if (head.length >= 3 && b(0) === 0xff && b(1) === 0xd8 && b(2) === 0xff) return true;
  if (
    head.length >= 8 &&
    b(0) === 0x89 && b(1) === 0x50 && b(2) === 0x4e && b(3) === 0x47 &&
    b(4) === 0x0d && b(5) === 0x0a && b(6) === 0x1a && b(7) === 0x0a
  ) return true;
  if (head.length >= 6 && head.slice(0, 6) === "GIF87a") return true;
  if (head.length >= 6 && head.slice(0, 6) === "GIF89a") return true;
  if (head.length >= 12 && head.slice(0, 4) === "RIFF" && head.slice(8, 12) === "WEBP") return true;
  return false;
}

function isWavBase64(value: string): boolean {
  const stripped = value.replace(/\s/g, "");
  if (stripped.length === 0) return true;
  if (stripped.length < 16) return false;
  const head = atob(stripped.slice(0, 16));
  return head.length >= 12 && head.slice(0, 4) === "RIFF" && head.slice(8, 12) === "WAVE";
}

/**
 * True when the WAV is in the format Meta transcribe accepts, per its
 * 400 on the 2026-10-28 2:40 AM test (8 kHz rejected: "expected
 * mono s16le at 16000 or 24000 Hz"). The fmt chunk is found by
 * scanning RIFF chunks, not by assuming it sits at offset 12, so an
 * extra chunk before fmt does not break it. Empty passes (no audio),
 * and a WAV with no fmt chunk in the decoded head passes too and is
 * left to the transcribe step, so this only rejects audio Meta is
 * known to refuse. Decoded with atob (not Buffer) so this pure module
 * stays free of node types.
 */
function isTranscribeWavBase64(value: string): boolean {
  const stripped = value.replace(/\s/g, "");
  if (stripped.length === 0) return true;
  // 200 bytes covers a standard header plus small leading chunks.
  const chunk = stripped.slice(0, 268);
  const head = atob(chunk.slice(0, chunk.length - (chunk.length % 4)));
  if (head.length < 12) return false;
  const u16 = (i: number): number => head.charCodeAt(i) | (head.charCodeAt(i + 1) << 8);
  const u32 = (i: number): number =>
    head.charCodeAt(i) |
    (head.charCodeAt(i + 1) << 8) |
    (head.charCodeAt(i + 2) << 16) |
    (head.charCodeAt(i + 3) << 24);
  let off = 12;
  while (off + 8 <= head.length) {
    const id = head.slice(off, off + 4);
    const size = u32(off + 4);
    if (id === "fmt " && size >= 16 && off + 8 + 16 <= head.length) {
      const format = u16(off + 8);
      const channels = u16(off + 10);
      const sampleRate = u32(off + 12);
      const bits = u16(off + 22);
      return (
        format === 1 &&
        channels === 1 &&
        (sampleRate === 16000 || sampleRate === 24000) &&
        bits === 16
      );
    }
    off += 8 + size + (size % 2);
  }
  return true;
}

export function validatePlanRequest(body: unknown): string[] {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return ["plan request must be a JSON object"];
  }
  const req = body as Record<string, unknown>;
  const problems: string[] = [];

  if (typeof req.durationSec !== "number" || !Number.isFinite(req.durationSec) || req.durationSec < 0) {
    problems.push("durationSec must be a number >= 0");
  }

  if (!Array.isArray(req.frames)) {
    problems.push("frames must be an array");
  } else if (req.frames.length === 0) {
    problems.push("frames must not be empty");
  } else if (req.frames.length > MAX_PLAN_FRAMES) {
    problems.push(`frames must not exceed ${MAX_PLAN_FRAMES}`);
  } else {
    let prevTsec = -Infinity;
    req.frames.forEach((f, i) => {
      if (f === null || typeof f !== "object" || Array.isArray(f)) {
        problems.push(`frames[${i}] must be an object`);
        return;
      }
      const frame = f as Record<string, unknown>;
      if (typeof frame.tSec !== "number" || !Number.isFinite(frame.tSec) || frame.tSec < 0) {
        problems.push(`frames[${i}].tSec must be a number >= 0`);
      } else {
        // The order and duration checks are independent, and prevTsec
        // advances on every valid tSec — even one that exceeds
        // durationSec. The old else-if chain only advanced prevTsec
        // on a clean frame, so a frame after an over-duration frame
        // was compared against an older timestamp and an out-of-order
        // frame (e.g. 5, 12, 6 with duration 10) slipped through.
        if (frame.tSec < prevTsec) {
          problems.push(`frames[${i}].tSec must not be earlier than the previous frame`);
        }
        if (
          typeof req.durationSec === "number" &&
          Number.isFinite(req.durationSec) &&
          req.durationSec >= 0 &&
          frame.tSec > req.durationSec
        ) {
          problems.push(`frames[${i}].tSec must not exceed durationSec`);
        }
        prevTsec = frame.tSec;
      }
      if (
        typeof frame.dataUrl !== "string" ||
        !frame.dataUrl.startsWith("data:image/") ||
        !frame.dataUrl.includes(";base64,")
      ) {
        problems.push(`frames[${i}].dataUrl must be a data:image base64 URL`);
      } else {
        const payload = frame.dataUrl.slice(frame.dataUrl.indexOf(";base64,") + 8);
        if (payload.length === 0 || !isBase64(payload)) {
          problems.push(`frames[${i}].dataUrl must carry valid base64 image data`);
        } else if (!isImageBase64(payload)) {
          problems.push(`frames[${i}].dataUrl must carry image data (JPEG, PNG, WebP, or GIF)`);
        } else {
          // Same shape as the step and caller caps: the route body
          // cap is 10 MB, so a single frame over 5 MB would pass
          // this gate and only surface later, in runPlan, instead
          // of failing fast here on "uploading" before any model
          // call is spent. 5 MB decoded is wide headroom over a
          // 1024 px JPEG frame, so no valid request changes.
          const stripped = payload.replace(/\s/g, "");
          const padding = stripped.endsWith("==") ? 2 : stripped.endsWith("=") ? 1 : 0;
          const decodedBytes = (stripped.length * 3) / 4 - padding;
          if (decodedBytes > MAX_PLAN_FRAME_IMAGE_BYTES) {
            problems.push(`frames[${i}].dataUrl must be at most 5 MB, got ${decodedBytes} bytes`);
          }
        }
      }
      // zoneId is optional (types.ts: PlanRequest frames), but when
      // present it must be a whole number >= 0, the same rule segment
      // enforces: an unvalidated zoneId used to pass this boundary
      // and fail deep inside segment instead of fast on "uploading".
      if (
        frame.zoneId !== undefined &&
        (typeof frame.zoneId !== "number" ||
          !Number.isInteger(frame.zoneId) ||
          frame.zoneId < 0)
      ) {
        problems.push(`frames[${i}].zoneId must be a whole number >= 0 when given`);
      }
    });
  }

  for (const key of ["spaceName", "spaceType", "region"]) {
    if (req[key] !== undefined && typeof req[key] !== "string") {
      problems.push(`${key} must be a string`);
    } else if (
      typeof req[key] === "string" &&
      req[key].length > 0 &&
      req[key].trim().length === 0
    ) {
      // A present-but-blank label is never what the UI sends: an
      // empty string means "not given", but spaces-only would print
      // as a blank label on the plan screen, so fail fast here.
      problems.push(`${key} must not be blank`);
    }
  }
  if (req.audioWavBase64 !== undefined) {
    if (typeof req.audioWavBase64 !== "string") {
      problems.push("audioWavBase64 must be a string");
    } else if (
      req.audioWavBase64.length > 0 &&
      req.audioWavBase64.replace(/\s/g, "").length === 0
    ) {
      problems.push("audioWavBase64 must not be blank");
    } else if (!isBase64(req.audioWavBase64)) {
      problems.push("audioWavBase64 must be valid base64");
    } else if (!isWavBase64(req.audioWavBase64)) {
      problems.push("audioWavBase64 must be a WAV file (RIFF/WAVE header)");
    } else if (!isTranscribeWavBase64(req.audioWavBase64)) {
      problems.push(
        "audioWavBase64 must be mono 16-bit WAV at 16000 or 24000 Hz (the format Meta transcribe accepts)",
      );
    }
  }
  // Parity with runPlan's own validator (validateRunPlanRequest in
  // runPlan.ts): a request may carry narration already transcribed by
  // POST /api/transcribe instead of the WAV, so the route must check
  // the pair here on "uploading" instead of letting a bad pair ride
  // into the pipeline and fail at "listening". Null means no
  // narration (the transcribe route's empty result); a blank string
  // is neither, so it fails. Turns without a transcript would be
  // silently ignored by the listening stage, so they fail too — the
  // pair arrives together from /api/transcribe. No separate length
  // cap: the 10 MB body cap above already bounds the transcript, and
  // runPlan sets no cap either, so parity means none here.
  if (
    req.transcript !== undefined &&
    req.transcript !== null &&
    typeof req.transcript !== "string"
  ) {
    problems.push("transcript must be a string or null when given");
  } else if (
    typeof req.transcript === "string" &&
    req.transcript.trim().length === 0
  ) {
    problems.push("transcript must not be blank when given");
  }
  if (req.transcriptTurns !== undefined) {
    if (!Array.isArray(req.transcriptTurns)) {
      problems.push("transcriptTurns must be an array when given");
    } else {
      // Parity with runPlan's validator: null means no narration,
      // so non-empty turns with a null transcript contradict it
      // just as turns with no transcript at all do — the listening
      // stage would hand the reason step a null transcript while
      // the finished plan still carried the turns. An empty turns
      // array with null stays valid: that is the real
      // empty-narration case from /api/transcribe.
      if (
        req.transcript === undefined ||
        (req.transcript === null && req.transcriptTurns.length > 0)
      ) {
        problems.push("transcriptTurns given without transcript");
      }
      // Time order, like frames above: the plan carries the turns in
      // order, and the reason step reads narration against frames in
      // that order, so an out-of-order turn would misalign what was
      // said with what was seen. Real turns from /api/transcribe are
      // already sorted (parseTurns sorts by startSec), so no current
      // run changes; equal startSec passes, as with frames.
      let prevTurnStartSec = -Infinity;
      req.transcriptTurns.forEach((turn, i) => {
        const t = turn as Record<string, unknown> | null;
        if (
          t === null ||
          typeof t !== "object" ||
          typeof t.startSec !== "number" ||
          !Number.isFinite(t.startSec) ||
          t.startSec < 0 ||
          typeof t.text !== "string" ||
          (t.endSec !== undefined &&
            (typeof t.endSec !== "number" ||
              !Number.isFinite(t.endSec) ||
              t.endSec < 0))
        ) {
          problems.push(`transcriptTurns[${i}] is not a valid turn`);
        } else if (
          // A turn with no words carries no narration: parseTurns
          // (src/lib/pipeline/transcribe.ts) already drops blank
          // turns and trims the rest, so a blank turn here comes
          // only from a direct caller, and the reason step would
          // otherwise carry an empty line into the "said vs saw"
          // alignment. Real turns from /api/transcribe are never
          // blank, so no current run changes.
          typeof t.text === "string" &&
          t.text.trim().length === 0
        ) {
          problems.push(`transcriptTurns[${i}].text must not be blank`);
        } else if (
          // A turn that ends before it starts is malformed, not just
          // out of order: the "said vs saw" alignment reads turns in
          // time order, so an inverted turn would misplace narration
          // instead of failing. The shape check above already rejects
          // a non-numeric endSec, so this only fires on a real number
          // earlier than startSec. Real turns (from /api/transcribe)
          // never invert, so no current run changes.
          typeof t.endSec === "number" &&
          t.endSec < t.startSec
        ) {
          problems.push(`transcriptTurns[${i}].endSec must not be earlier than startSec`);
        }
        // Independent of the two checks above, and prevTurnStartSec
        // advances on every valid startSec — even one whose endSec
        // failed — so a turn after a bad turn is compared against
        // the latest timestamp, not an older one (the same rule the
        // frame-order check above follows).
        if (
          t !== null &&
          typeof t === "object" &&
          typeof t.startSec === "number" &&
          Number.isFinite(t.startSec) &&
          t.startSec >= 0
        ) {
          if (t.startSec < prevTurnStartSec) {
            problems.push(`transcriptTurns[${i}].startSec must not be earlier than the previous turn`);
          }
          prevTurnStartSec = t.startSec;
        }
        // Like frames above: a turn that starts after the video ends
        // cannot line up with anything seen, so it would mislabel
        // narration on the plan screen. Real turns from
        // /api/transcribe start inside the audio, so no current run
        // changes. Only the start is checked: an endSec past
        // durationSec is harmless for alignment, since the turn
        // itself still starts inside the video.
        if (
          t !== null &&
          typeof t === "object" &&
          typeof t.startSec === "number" &&
          Number.isFinite(t.startSec) &&
          t.startSec >= 0 &&
          typeof req.durationSec === "number" &&
          Number.isFinite(req.durationSec) &&
          req.durationSec >= 0 &&
          t.startSec > req.durationSec
        ) {
          problems.push(`transcriptTurns[${i}].startSec must not exceed durationSec`);
        }
      });
    }
  }
  if (
    req.laborBasis !== undefined &&
    req.laborBasis !== "volunteer" &&
    req.laborBasis !== "contractor" &&
    req.laborBasis !== "mixed"
  ) {
    problems.push("laborBasis must be volunteer, contractor, or mixed");
  }
  return problems;
}



