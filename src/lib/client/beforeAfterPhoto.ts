import { SHARE_SIGNOFF } from "./planText";

/**
 * "Send before and after": the real frame and the AI concept in one JPEG, side by side (stacked for tall
 * pictures), each labeled, with the concept caption along the bottom, so the picture can't be passed around
 * later as a photo of finished work. Phones share it through the share sheet; a computer downloads it.
 *
 * Built ahead of the tap (the share sheet needs the tap's user gesture), cached per pair of pictures. Anything
 * that can't be drawn (an image that won't load, a cross-origin image the canvas can't export) gives null.
 */

export const BEFORE_AFTER_MAX_SIDE = 1280;
export const BEFORE_AFTER_GAP = 8;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface BeforeAfterLayout {
  width: number;
  height: number;
  /** "row" = side by side, "column" = stacked. */
  direction: "row" | "column";
  before: Rect;
  after: Rect;
  /** The caption strip under both pictures. */
  caption: Rect;
}

/**
 * Where each picture goes. Both panels share the before frame's aspect (the after picture is cropped to cover it,
 * as on screen). Wide frames sit side by side, tall ones stack, so neither panel ends up a sliver. The longer side
 * of the whole picture is at most `max`. Null when a size is missing.
 */
export function beforeAfterLayout(beforeW: number, beforeH: number, max = BEFORE_AFTER_MAX_SIDE): BeforeAfterLayout | null {
  if (!(beforeW > 0) || !(beforeH > 0) || !(max > 0)) return null;
  const direction: "row" | "column" = beforeW >= beforeH ? "row" : "column";
  const gap = BEFORE_AFTER_GAP;
  const fit = (scale: number) => {
    const pw = Math.max(1, Math.floor(beforeW * scale));
    const ph = Math.max(1, Math.floor(beforeH * scale));
    const width = direction === "row" ? pw * 2 + gap : pw;
    const panelsHeight = direction === "row" ? ph : ph * 2 + gap;
    const captionH = Math.max(28, Math.round(Math.min(width, panelsHeight) * 0.07));
    return { pw, ph, width, panelsHeight, captionH };
  };
  // Start from the size that fits the panels, then step down until the caption fits too.
  let scale = Math.min(1, max / Math.max(direction === "row" ? beforeW * 2 + gap : beforeW, direction === "row" ? beforeH : beforeH * 2 + gap));
  let f = fit(scale);
  for (let i = 0; i < 60 && Math.max(f.width, f.panelsHeight + f.captionH) > max; i++) {
    scale *= 0.97;
    f = fit(scale);
  }
  const { pw, ph, width, panelsHeight, captionH } = f;
  const before: Rect = { x: 0, y: 0, w: pw, h: ph };
  const after: Rect = direction === "row" ? { x: pw + gap, y: 0, w: pw, h: ph } : { x: 0, y: ph + gap, w: pw, h: ph };
  return { width, height: panelsHeight + captionH, direction, before, after, caption: { x: 0, y: panelsHeight, w: width, h: captionH } };
}

/** Source crop so an image of `w`×`h` covers a `target` panel without stretching (like CSS object-fit: cover). */
export function coverCrop(w: number, h: number, target: { w: number; h: number }): Rect {
  if (!(w > 0) || !(h > 0) || !(target.w > 0) || !(target.h > 0)) return { x: 0, y: 0, w: Math.max(0, w), h: Math.max(0, h) };
  const want = target.w / target.h;
  if (w / h > want) {
    const cw = h * want;
    return { x: (w - cw) / 2, y: 0, w: cw, h };
  }
  const ch = w / want;
  return { x: 0, y: (h - ch) / 2, w, h: ch };
}

function slug(text: string): string {
  const full = text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (full.length <= 40) return full;
  const head = full.slice(0, 41);
  const brk = head.lastIndexOf("-");
  return (brk > 0 ? head.slice(0, brk) : full.slice(0, 40)).replace(/-+$/g, "");
}

/** File name: "sightwork-before-after-sanctuary-stage.jpg". */
export function beforeAfterName(spaceName: string | null | undefined): string {
  const s = slug(spaceName ?? "");
  return `sightwork-before-after${s ? `-${s}` : ""}.jpg`;
}

/** Share sheet title. */
export function beforeAfterShareTitle(spaceName: string | null | undefined): string {
  const name = (spaceName ?? "").trim();
  return name ? `Before and after: ${name}` : "Before and after";
}

/** Short caption fitted to the layout: side by side says left/right, stacked says top/bottom. */
export function beforeAfterCaptionFor(direction: "row" | "column", label: string): string {
  const l = label.trim().replace(/\.$/, "") || "AI concept";
  return direction === "row" ? `After (right): ${l} · SightWork` : `After (bottom): ${l} · SightWork`;
}

/** The text that goes with the picture. Example plans say so. */
export function beforeAfterShareText(spaceName: string | null | undefined, label: string, opts: { sample?: boolean } = {}): string {
  const name = (spaceName ?? "").trim();
  const l = label.trim().replace(/\.$/, "") || "AI concept";
  const lines = [
    name ? `Before and after for ${name}.` : "Before and after.",
    "Before: a frame from the walkthrough video.",
    `After: ${l}. It shows what the space could look like once the work is done.`,
  ];
  if (opts.sample) lines.push("From SightWork's example plan.");
  lines.push("", SHARE_SIGNOFF);
  return lines.join("\n");
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    if (/^https?:/i.test(url) && typeof location !== "undefined" && !url.startsWith(location.origin)) img.crossOrigin = "anonymous";
    img.decoding = "async";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("image did not load"));
    img.src = url;
  });
}

function drawTag(ctx: CanvasRenderingContext2D, text: string, panel: Rect) {
  const size = Math.max(14, Math.round(Math.min(panel.w, panel.h) * 0.055));
  ctx.font = `600 ${size}px system-ui, -apple-system, "Segoe UI", sans-serif`;
  const pad = Math.round(size * 0.5);
  const w = ctx.measureText(text).width + pad * 2;
  const h = size + pad;
  const x = panel.x + pad;
  const y = panel.y + panel.h - h - pad;
  ctx.fillStyle = "rgba(0,0,0,0.7)";
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = "#ffffff";
  ctx.textBaseline = "middle";
  ctx.fillText(text, x + pad, y + h / 2);
}

/** Draws both pictures, their tags and the caption, and encodes a JPEG. Null when anything fails. */
export async function buildBeforeAfterPhoto(before: string, after: string, opts: { spaceName?: string | null; label: string }): Promise<File | null> {
  if (!before || !after || typeof document === "undefined") return null;
  try {
    const [b, a] = await Promise.all([loadImage(before), loadImage(after)]);
    const layout = beforeAfterLayout(b.naturalWidth, b.naturalHeight);
    if (!layout || !(a.naturalWidth > 0)) return null;
    const canvas = document.createElement("canvas");
    canvas.width = layout.width;
    canvas.height = layout.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.fillStyle = "#0f172a";
    ctx.fillRect(0, 0, layout.width, layout.height);
    const bc = coverCrop(b.naturalWidth, b.naturalHeight, layout.before);
    ctx.drawImage(b, bc.x, bc.y, bc.w, bc.h, layout.before.x, layout.before.y, layout.before.w, layout.before.h);
    const ac = coverCrop(a.naturalWidth, a.naturalHeight, layout.after);
    ctx.drawImage(a, ac.x, ac.y, ac.w, ac.h, layout.after.x, layout.after.y, layout.after.w, layout.after.h);
    drawTag(ctx, "Before", layout.before);
    drawTag(ctx, "After (AI concept)", layout.after);
    const c = layout.caption;
    const size = Math.max(12, Math.round(c.h * 0.45));
    ctx.font = `500 ${size}px system-ui, -apple-system, "Segoe UI", sans-serif`;
    ctx.fillStyle = "rgba(255,255,255,0.85)";
    ctx.textBaseline = "middle";
    let caption = beforeAfterCaptionFor(layout.direction, opts.label);
    while (caption.length > 12 && ctx.measureText(caption).width > c.w - size * 2) caption = `${caption.slice(0, -2).trimEnd()}…`;
    ctx.fillText(caption, c.x + size, c.y + c.h / 2);
    const blob = await new Promise<Blob | null>((resolve) => {
      try {
        canvas.toBlob(resolve, "image/jpeg", 0.85);
      } catch {
        resolve(null);
      }
    });
    if (!blob || blob.size === 0) return null;
    return new File([blob], beforeAfterName(opts.spaceName), { type: "image/jpeg" });
  } catch {
    return null;
  }
}

const cache = new Map<string, Promise<File | null>>();
const keyOf = (u: string) => (u.length > 200 ? `${u.length}:${u.slice(-120)}` : u);

/** Same as buildBeforeAfterPhoto, built once per pair of pictures, place and label. */
export function getBeforeAfterPhoto(before: string, after: string, opts: { spaceName?: string | null; label: string }): Promise<File | null> {
  if (!before || !after) return Promise.resolve(null);
  const key = `${keyOf(before)}|${keyOf(after)}|${opts.spaceName ?? ""}|${opts.label}`;
  let p = cache.get(key);
  if (!p) {
    p = buildBeforeAfterPhoto(before, after, opts);
    cache.set(key, p);
    if (cache.size > 8) cache.delete(cache.keys().next().value as string);
  }
  return p;
}
