#!/usr/bin/env node
/**
 * SightWork frame sampler.
 *
 * Picks the still frames the pipeline looks at, from one walkthrough video:
 *   1. one frame every --interval seconds (default 2 s)
 *   2. plus every scene change (ffmpeg scene score > --scene, default 0.3)
 *   3. drops near-duplicates (difference hash, Hamming distance <= --dedupe)
 *   4. drops blurry frames (Laplacian variance < --blur-ratio x median)
 *   5. caps the result at --max frames (default 48, under the 50-image limit)
 * Writes JPEGs named with their timestamp plus manifest.json.
 *
 * Needs ffmpeg and ffprobe on PATH. No npm dependencies. Makes no network calls.
 *
 * Usage:
 *   node tools/frames/sample-frames.mjs <video> [--out dir] [--interval 2]
 *     [--scene 0.3] [--min-gap 0.75] [--max 48] [--long-side 1024]
 *     [--dedupe 5] [--blur-ratio 0.35] [--wav]
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { basename, extname, join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const opts = {
    out: "", interval: 2, scene: 0.3, minGap: 0.75, max: 48, longSide: 1024,
    dedupe: 5, blurRatio: 0.35, wav: false,
  };
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case "--out": opts.out = next(); break;
      case "--interval": opts.interval = Number(next()); break;
      case "--scene": opts.scene = Number(next()); break;
      case "--min-gap": opts.minGap = Number(next()); break;
      case "--max": opts.max = Number(next()); break;
      case "--long-side": opts.longSide = Number(next()); break;
      case "--dedupe": opts.dedupe = Number(next()); break;
      case "--blur-ratio": opts.blurRatio = Number(next()); break;
      case "--wav": opts.wav = true; break;
      case "-h": case "--help": opts.help = true; break;
      default:
        if (a.startsWith("--")) throw new Error(`Unknown option ${a}`);
        pos.push(a);
    }
  }
  opts.input = pos[0];
  return opts;
}

function run(cmd, args, { binary = false } = {}) {
  const r = spawnSync(cmd, args, { maxBuffer: 1 << 28, encoding: binary ? "buffer" : "utf8" });
  if (r.error) throw r.error;
  if (r.status !== 0) {
    const err = binary ? r.stderr.toString() : r.stderr;
    throw new Error(`${cmd} failed: ${err.split("\n").slice(-5).join("\n")}`);
  }
  return r;
}

function probeDuration(input) {
  const r = run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", input]);
  const d = Number(r.stdout.trim());
  if (!Number.isFinite(d) || d <= 0) throw new Error("Could not read video duration");
  return d;
}

/** Scene-change timestamps with scores, from ffmpeg's scene detector. */
function sceneChanges(input, threshold) {
  const r = run("ffmpeg", [
    "-hide_banner", "-nostats", "-i", input, "-an",
    "-vf", `scale=320:-2,select='gt(scene,${threshold})',metadata=print:file=-`,
    "-f", "null", "-",
  ]);
  const out = [];
  let t = null;
  for (const line of r.stdout.split("\n")) {
    const m = line.match(/pts_time:([\d.]+)/);
    if (m) t = Number(m[1]);
    const s = line.match(/lavfi\.scene_score=([\d.]+)/);
    if (s && t !== null) { out.push({ tSec: t, score: Number(s[1]) }); t = null; }
  }
  return out;
}

const SMALL = 128;
/** 128x128 grayscale pixels of the frame at time t. */
function grayAt(input, t) {
  const r = run("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-ss", t.toFixed(3), "-i", input,
    "-frames:v", "1", "-vf", `scale=${SMALL}:${SMALL},format=gray`, "-f", "rawvideo", "-",
  ], { binary: true });
  if (r.stdout.length < SMALL * SMALL) return null;
  return r.stdout.subarray(0, SMALL * SMALL);
}

/** 64-bit difference hash as a BigInt (9x8 box-downsample of the 128x128 gray). */
function dHash(px) {
  const W = 9, H = 8, small = new Float64Array(W * H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const x0 = Math.floor((x * SMALL) / W), x1 = Math.floor(((x + 1) * SMALL) / W);
      const y0 = Math.floor((y * SMALL) / H), y1 = Math.floor(((y + 1) * SMALL) / H);
      let sum = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) { sum += px[yy * SMALL + xx]; n++; }
      small[y * W + x] = sum / n;
    }
  let h = 0n;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W - 1; x++) h = (h << 1n) | (small[y * W + x] > small[y * W + x + 1] ? 1n : 0n);
  return h;
}

function hamming(a, b) {
  let x = a ^ b, n = 0;
  while (x) { n += Number(x & 1n); x >>= 1n; }
  return n;
}

/** Variance of the Laplacian: low means blurry (or a flat, featureless frame). */
function sharpness(px) {
  const vals = [];
  for (let y = 1; y < SMALL - 1; y++)
    for (let x = 1; x < SMALL - 1; x++) {
      const i = y * SMALL + x;
      vals.push(px[i - SMALL] + px[i + SMALL] + px[i - 1] + px[i + 1] - 4 * px[i]);
    }
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  return vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length;
}

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
}

function fileName(i, t) {
  return `f${String(i).padStart(3, "0")}_t${t.toFixed(2).padStart(9, "0")}s.jpg`;
}

function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help || !o.input) {
    console.log("Usage: node tools/frames/sample-frames.mjs <video> [--out dir] [--interval 2] [--scene 0.3] [--min-gap 0.75] [--max 48] [--long-side 1024] [--dedupe 5] [--blur-ratio 0.35] [--wav]");
    process.exit(o.help ? 0 : 1);
  }
  const input = resolve(o.input);
  if (!existsSync(input)) throw new Error(`No such file: ${input}`);
  const outDir = resolve(o.out || join(HERE, "out", basename(input, extname(input))));
  mkdirSync(outDir, { recursive: true });
  for (const f of readdirSync(outDir)) if (/^f\d{3}_t.*\.jpg$/.test(f)) rmSync(join(outDir, f));

  const duration = probeDuration(input);
  const lastT = Math.max(0, duration - 0.05);

  // 1 + 2: candidate times
  const candidates = [];
  for (let t = 0; t < duration; t += o.interval) candidates.push({ tSec: Math.min(t, lastT), reason: "interval" });
  const scenes = sceneChanges(input, o.scene);
  for (const s of scenes) candidates.push({ tSec: Math.min(s.tSec, lastT), reason: "scene", sceneScore: s.score });
  candidates.sort((a, b) => a.tSec - b.tSec || (a.reason === "scene" ? -1 : 1));

  // min gap: a scene frame replaces an interval frame that is too close
  const spaced = [];
  for (const c of candidates) {
    const prev = spaced[spaced.length - 1];
    if (prev && c.tSec - prev.tSec < o.minGap) {
      if (c.reason === "scene" && prev.reason === "interval") spaced[spaced.length - 1] = c;
      continue;
    }
    spaced.push(c);
  }

  // 3 + 4: measure, then drop blurry and near-duplicate frames
  const measured = [];
  for (const c of spaced) {
    const px = grayAt(input, c.tSec);
    if (!px) continue;
    measured.push({ ...c, hash: dHash(px), sharp: sharpness(px) });
  }
  const sharpCut = o.blurRatio * median(measured.map((m) => m.sharp));
  let droppedBlur = 0, droppedDup = 0;
  const kept = [];
  for (const m of measured) {
    if (m.sharp < sharpCut) { droppedBlur++; continue; }
    if (kept.some((k) => hamming(k.hash, m.hash) <= o.dedupe)) { droppedDup++; continue; }
    kept.push(m);
  }

  // 5: cap, spread evenly over time, scene frames first when trimming
  let final = kept;
  if (kept.length > o.max) {
    const scenesFirst = kept.filter((k) => k.reason === "scene").slice(0, Math.floor(o.max / 2));
    const rest = kept.filter((k) => !scenesFirst.includes(k));
    const need = o.max - scenesFirst.length;
    const picked = Array.from({ length: need }, (_, i) => rest[Math.floor((i * rest.length) / need)]);
    final = [...scenesFirst, ...picked].sort((a, b) => a.tSec - b.tSec);
  }

  // write JPEGs
  const scale = `scale='if(gte(iw,ih),min(${o.longSide},iw),-2)':'if(gte(iw,ih),-2,min(${o.longSide},ih))'`;
  const frames = final.map((m, i) => {
    const file = fileName(i, m.tSec);
    run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-ss", m.tSec.toFixed(3), "-i", input,
      "-frames:v", "1", "-vf", scale, "-q:v", "3", join(outDir, file)]);
    const f = { index: i, tSec: Number(m.tSec.toFixed(2)), file, reason: m.reason };
    if (m.sceneScore !== undefined) f.sceneScore = Number(m.sceneScore.toFixed(3));
    return f;
  });

  if (o.wav) {
    run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", input, "-vn", "-ac", "1", "-ar", "24000",
      "-c:a", "pcm_s16le", join(outDir, "audio.wav")]);
  }

  const manifest = {
    source: basename(input),
    durationSec: Number(duration.toFixed(2)),
    generatedAt: new Date().toISOString(),
    settings: { intervalSec: o.interval, sceneThreshold: o.scene, minGapSec: o.minGap, maxFrames: o.max, longSidePx: o.longSide },
    frames,
  };
  writeFileSync(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

  console.log(
    `${frames.length} frames -> ${outDir}\n` +
    `  candidates ${candidates.length} (scene changes ${scenes.length}), after min-gap ${spaced.length}, ` +
    `dropped blurry ${droppedBlur}, dropped duplicates ${droppedDup}, capped to ${o.max}`,
  );
}

try {
  main();
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
}
