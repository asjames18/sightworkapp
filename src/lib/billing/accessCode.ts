// Signed access codes for paid plans. Server only.
//
// Stripe is the system of record: a code only says which Stripe customer (plan packs) or
// subscription (monthly and yearly plans) it belongs to. What it is still worth (credits left,
// subscription active) is always read from Stripe when the code is used, so a code never needs
// to be stored anywhere and can be re-issued at any time from the same Stripe object.
//
// Format: "sw1." + base64url(JSON payload) + "." + base64url(HMAC-SHA256(secret, "sw1." + payload)).
// The secret lives only in the SIGHTWORK_ACCESS_SECRET environment variable.
import { createHmac, timingSafeEqual } from "node:crypto";

export const ACCESS_CODE_VERSION = "sw1";
/** Shortest secret accepted, in characters. */
export const MIN_ACCESS_SECRET_LENGTH = 32;
/** Longest code accepted, so a huge header is refused before any work. */
export const MAX_ACCESS_CODE_LENGTH = 512;

export type AccessKind = "pack" | "sub";

export interface AccessGrant {
  /** "pack" codes point at a Stripe customer; "sub" codes point at a Stripe subscription. */
  kind: AccessKind;
  /** The Stripe object id: cus_... for a pack, sub_... for a subscription. */
  stripeId: string;
  /** Livemode of the Stripe object, so test codes never work against live Stripe and the reverse. */
  live: boolean;
  /** When the code was issued, in whole seconds since 1970. */
  issuedAt: number;
}

export type VerifyResult =
  | { ok: true; grant: AccessGrant }
  | { ok: false; reason: "missing" | "malformed" | "bad-signature" | "wrong-mode" };

const STRIPE_ID = /^(cus|sub)_[A-Za-z0-9]{6,64}$/;

/** Billing is on only when SIGHTWORK_BILLING is exactly "on". */
export function billingEnabled(flag: string | undefined = process.env.SIGHTWORK_BILLING): boolean {
  return flag === "on";
}

/** The signing secret, or null when it is missing or too short to trust. */
export function accessSecret(raw: string | undefined = process.env.SIGHTWORK_ACCESS_SECRET): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  return s.length >= MIN_ACCESS_SECRET_LENGTH ? s : null;
}

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

function sign(secret: string, body: string): Buffer {
  return createHmac("sha256", secret).update(body).digest();
}

function checkGrant(g: AccessGrant): void {
  if (g.kind !== "pack" && g.kind !== "sub") throw new Error("accessCode: kind must be pack or sub");
  if (typeof g.stripeId !== "string" || !STRIPE_ID.test(g.stripeId)) {
    throw new Error("accessCode: stripeId must be a Stripe customer or subscription id");
  }
  const prefix = g.stripeId.slice(0, 3);
  if ((g.kind === "pack") !== (prefix === "cus")) {
    throw new Error("accessCode: a pack code needs a customer id and a subscription code needs a subscription id");
  }
  if (typeof g.live !== "boolean") throw new Error("accessCode: live must be true or false");
  if (!Number.isInteger(g.issuedAt) || g.issuedAt < 0) throw new Error("accessCode: issuedAt must be whole seconds");
}

/** Makes a code for a grant. Throws when the secret is missing or the grant is not valid. */
export function issueAccessCode(grant: AccessGrant, secret: string | null = accessSecret()): string {
  if (!secret) throw new Error("accessCode: the signing secret is not set");
  checkGrant(grant);
  const payload = b64url(
    Buffer.from(JSON.stringify({ k: grant.kind, id: grant.stripeId, l: grant.live ? 1 : 0, t: grant.issuedAt })),
  );
  const body = `${ACCESS_CODE_VERSION}.${payload}`;
  return `${body}.${b64url(sign(secret, body))}`;
}

/**
 * Checks a code's signature and shape. `live` is the mode the server runs in; a code from the
 * other mode is refused. A good result still has to be checked against Stripe before any run.
 */
export function verifyAccessCode(
  code: string | null | undefined,
  opts: { live: boolean; secret?: string | null },
): VerifyResult {
  const secret = opts.secret === undefined ? accessSecret() : opts.secret;
  if (typeof code !== "string" || code.trim() === "") return { ok: false, reason: "missing" };
  const c = code.trim();
  if (c.length > MAX_ACCESS_CODE_LENGTH || !secret) return { ok: false, reason: "malformed" };
  const parts = c.split(".");
  if (parts.length !== 3 || parts[0] !== ACCESS_CODE_VERSION) return { ok: false, reason: "malformed" };
  const [, payload, sig] = parts;
  if (!/^[A-Za-z0-9_-]+$/.test(payload) || !/^[A-Za-z0-9_-]+$/.test(sig)) return { ok: false, reason: "malformed" };

  const want = sign(secret, `${ACCESS_CODE_VERSION}.${payload}`);
  const got = Buffer.from(sig, "base64url");
  if (got.length !== want.length || !timingSafeEqual(got, want)) return { ok: false, reason: "bad-signature" };

  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  const r = raw as { k?: unknown; id?: unknown; l?: unknown; t?: unknown };
  const grant: AccessGrant = {
    kind: r.k as AccessKind,
    stripeId: r.id as string,
    live: r.l === 1,
    issuedAt: r.t as number,
  };
  try {
    if (r.l !== 0 && r.l !== 1) throw new Error("mode");
    checkGrant(grant);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (grant.live !== opts.live) return { ok: false, reason: "wrong-mode" };
  return { ok: true, grant };
}
