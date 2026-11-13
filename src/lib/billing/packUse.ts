// Counts finished plans on a plan-pack customer. Server only.
//
// Stripe is the system of record, so the count lives on the customer's metadata
// (sightwork_plans_used). Call this only after a plan finished; it never throws, so a
// bookkeeping blip can't fail a plan the customer already has. Two runs finishing at the
// same moment can both read the same count and lose one increment: Stripe metadata has no
// atomic counter, which is acceptable at plan-pack volumes.
import { STRIPE_API } from "./checkout";

export const PLANS_USED_KEY = "sightwork_plans_used";

type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export type PackUseResult = { ok: true; used: number } | { ok: false; reason: "bad-id" | "no-key" | "stripe" };

const CUSTOMER_ID = /^cus_[A-Za-z0-9]{6,64}$/;

/** Reads a stored count; anything that isn't a whole, non-negative number counts as 0. */
export function plansUsed(metadata: unknown): number {
  const raw = (metadata as Record<string, unknown> | null | undefined)?.[PLANS_USED_KEY];
  const n = typeof raw === "string" && /^\d{1,6}$/.test(raw) ? Number(raw) : 0;
  return Number.isSafeInteger(n) ? n : 0;
}

export async function recordPackUse(
  customerId: string,
  ctx: { env?: Record<string, string | undefined>; fetchImpl?: FetchLike } = {},
): Promise<PackUseResult> {
  if (typeof customerId !== "string" || !CUSTOMER_ID.test(customerId)) return { ok: false, reason: "bad-id" };
  const env = ctx.env ?? process.env;
  const key = env.STRIPE_SECRET_KEY?.trim();
  if (!key || !/^(sk|rk)_(test|live)_[A-Za-z0-9]+$/.test(key)) return { ok: false, reason: "no-key" };
  const f = ctx.fetchImpl ?? (fetch as unknown as FetchLike);
  const url = `${STRIPE_API}/customers/${customerId}`;
  const auth = { Authorization: `Bearer ${key}` };
  try {
    const got = await f(url, { method: "GET", headers: auth });
    if (!got.ok) return { ok: false, reason: "stripe" };
    const j = (await got.json()) as { deleted?: unknown; metadata?: unknown };
    if (j.deleted === true) return { ok: false, reason: "stripe" };
    const used = plansUsed(j.metadata) + 1;
    const body = new URLSearchParams([[`metadata[${PLANS_USED_KEY}]`, String(used)]]).toString();
    const put = await f(url, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    return put.ok ? { ok: true, used } : { ok: false, reason: "stripe" };
  } catch {
    return { ok: false, reason: "stripe" };
  }
}
