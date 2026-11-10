// The paid plans and where their Stripe price ids come from. Server only.
//
// Price ids differ between Stripe test mode and live mode, so they are read from environment
// variables, never written into the code. A plan whose price id is missing simply can't be bought.

export type PlanKey =
  | "single"
  | "pack5"
  | "church-monthly"
  | "church-yearly"
  | "ministry-monthly"
  | "ministry-yearly"
  | "multisite-monthly"
  | "multisite-yearly";

export interface PaidPlan {
  key: PlanKey;
  /** Name shown to buyers. */
  name: string;
  /** "payment" for one-time packs, "subscription" for monthly and yearly plans. */
  mode: "payment" | "subscription";
  /** Plan runs a pack adds (packs only). */
  credits?: number;
  /** Yearly plans are the only ones that take a nonprofit discount code. */
  yearly: boolean;
  /** Environment variable holding this plan's Stripe price id. */
  priceEnv: string;
  /** Price in whole US dollars, for display only (Stripe decides what is charged). */
  usd: number;
}

export const PAID_PLANS: readonly PaidPlan[] = [
  { key: "single", name: "Single Plan", mode: "payment", credits: 1, yearly: false, priceEnv: "SIGHTWORK_PRICE_SINGLE", usd: 9 },
  { key: "pack5", name: "5-Plan Pack", mode: "payment", credits: 5, yearly: false, priceEnv: "SIGHTWORK_PRICE_PACK5", usd: 29 },
  { key: "church-monthly", name: "Church & Small Facility, monthly", mode: "subscription", yearly: false, priceEnv: "SIGHTWORK_PRICE_CHURCH_MONTHLY", usd: 19 },
  { key: "church-yearly", name: "Church & Small Facility, yearly", mode: "subscription", yearly: true, priceEnv: "SIGHTWORK_PRICE_CHURCH_YEARLY", usd: 190 },
  { key: "ministry-monthly", name: "Ministry & School, monthly", mode: "subscription", yearly: false, priceEnv: "SIGHTWORK_PRICE_MINISTRY_MONTHLY", usd: 49 },
  { key: "ministry-yearly", name: "Ministry & School, yearly", mode: "subscription", yearly: true, priceEnv: "SIGHTWORK_PRICE_MINISTRY_YEARLY", usd: 490 },
  { key: "multisite-monthly", name: "Multi-site, monthly", mode: "subscription", yearly: false, priceEnv: "SIGHTWORK_PRICE_MULTISITE_MONTHLY", usd: 129 },
  { key: "multisite-yearly", name: "Multi-site, yearly", mode: "subscription", yearly: true, priceEnv: "SIGHTWORK_PRICE_MULTISITE_YEARLY", usd: 1290 },
];

export function findPlan(key: unknown): PaidPlan | null {
  return typeof key === "string" ? (PAID_PLANS.find((p) => p.key === key) ?? null) : null;
}

const PRICE_ID = /^price_[A-Za-z0-9]{6,64}$/;

/** The plan's Stripe price id from the environment, or null when it is missing or not a price id. */
export function planPriceId(plan: PaidPlan, env: Record<string, string | undefined> = process.env): string | null {
  const v = env[plan.priceEnv]?.trim();
  return v && PRICE_ID.test(v) ? v : null;
}
