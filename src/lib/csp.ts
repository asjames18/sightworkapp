/**
 * The site's Content-Security-Policy, built once at config time (next.config.ts).
 *
 * - Scripts, styles, fonts, frames and workers come only from this site. Next.js writes its page bootstrap
 *   inline and the example plan is prerendered (no per-request nonce), so scripts and styles allow
 *   'unsafe-inline'; 'unsafe-eval' is only added for `next dev`.
 * - The browser may talk to this site only (plus blob: and data: URLs it made itself, e.g. reading a recorded take). With own-key mode on (NEXT_PUBLIC_SIGHTWORK_BYOK=on) it may
 *   also reach the Meta API host, and nothing else, so a saved key can only ever go to Meta.
 * - Pictures and video may be this site, data: or blob: (frames, the recorder, the after picture, PDFs).
 * - No plugins, no framing by other sites, no <base> hijack, forms post only here.
 */
export const META_API_ORIGIN = "https://api.meta.ai";

export type CspOptions = { byok: boolean; dev: boolean };

export function cspDirectives({ byok, dev }: CspOptions): Record<string, string[]> {
  return {
    "default-src": ["'self'"],
    "script-src": ["'self'", "'unsafe-inline'", ...(dev ? ["'unsafe-eval'"] : [])],
    "style-src": ["'self'", "'unsafe-inline'"],
    "img-src": ["'self'", "data:", "blob:"],
    "media-src": ["'self'", "data:", "blob:", "mediastream:"],
    "font-src": ["'self'", "data:"],
    "connect-src": ["'self'", "blob:", "data:", ...(byok ? [META_API_ORIGIN] : []), ...(dev ? ["ws:"] : [])],
    "worker-src": ["'self'", "blob:"],
    "manifest-src": ["'self'"],
    "frame-src": ["'self'", "blob:"],
    "frame-ancestors": ["'none'"],
    "object-src": ["'none'"],
    "base-uri": ["'self'"],
    "form-action": ["'self'"],
  };
}

export function buildCsp(opts: CspOptions): string {
  return Object.entries(cspDirectives(opts))
    .map(([name, values]) => `${name} ${values.join(" ")}`)
    .join("; ");
}

/** Own-key mode is on only for the exact value "on" (matches byokEnabled in src/lib/client/byokKey.ts). */
export function byokFlagOn(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === "on";
}
