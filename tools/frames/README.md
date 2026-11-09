# Frame sampler

Picks the still frames SightWork analyzes from a walkthrough video. Needs `ffmpeg` and `ffprobe` on PATH. It has no npm dependencies and makes no network calls.

```bash
npm run frames -- path/to/walkthrough.mp4          # writes tools/frames/out/<name>/
npm run frames -- walkthrough.mov --wav --max 32    # also writes audio.wav (24 kHz mono PCM)
```

How it picks frames:
1. One frame every `--interval` seconds (default 2).
2. Plus every scene change (ffmpeg scene score above `--scene`, default 0.3). A scene frame replaces an interval frame closer than `--min-gap` (0.75 s).
3. Drops near-duplicates: a 64-bit difference hash within `--dedupe` bits (default 5) of a frame already kept.
4. Drops blurry frames: Laplacian variance below `--blur-ratio` (0.35) times the median.
5. Caps at `--max` frames (default 48, under the 50-images-per-request limit), spread over time, with scene changes kept first.
6. Writes JPEGs at most `--long-side` px (1024) named `f<index>_t<seconds>s.jpg`, plus `manifest.json` (the `FrameManifest` type in `src/lib/types.ts`).

Output folders are gitignored.

Test with a synthetic video:
```bash
bash tools/frames/make-test-video.sh   # tools/frames/test/synthetic.mp4 (34 s: 5 shots, one blurred)
npm run frames -- tools/frames/test/synthetic.mp4 --wav
```
