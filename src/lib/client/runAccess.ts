/**
 * How someone without a code or key gets to make a plan from their own video. Two ways, offered together:
 * - Use your own Meta API key, free (own-key mode, kept in this browser, set in Settings);
 * - Buy plans on the pricing page (Stripe checkout, an access code comes back).
 * Read in the browser and on the server: both flags are public build-time values.
 */
import { byokEnabled } from "./byokKey";

export const PRICING_HREF = "/pricing";
export const SETTINGS_HREF = "/settings";
export const OWN_KEY_GUIDE_HREF = "/help/own-key";

/**
 * Paid plans are on for this build. next.config.ts copies SIGHTWORK_BILLING (server only) into
 * NEXT_PUBLIC_SIGHTWORK_PAID_PLANS at build time, so pages and the app know whether /pricing exists.
 */
export function paidPlansOn(envValue: string | undefined = process.env.NEXT_PUBLIC_SIGHTWORK_PAID_PLANS): boolean {
  return envValue?.trim().toLowerCase() === "on";
}

export type RunOption = { key: "own-key" | "buy"; label: string; detail: string; href: string };

/** The ways to run a plan this build offers, own key first because it is free. */
export function runOptions(paid: boolean = paidPlansOn(), byok: boolean = byokEnabled()): RunOption[] {
  const out: RunOption[] = [];
  if (byok)
    out.push({
      key: "own-key",
      label: "Use your own key (free)",
      detail: "Paste a Meta API key once. It stays in this browser and Meta bills you directly, about $1 a plan.",
      href: SETTINGS_HREF,
    });
  if (paid)
    out.push({
      key: "buy",
      label: "Buy plans",
      detail: "No key needed. One plan for $9, or 5 for $29. You get an access code right after checkout.",
      href: PRICING_HREF,
    });
  return out;
}

/**
 * Show the "how do you want to run it?" choice for a server run with nothing saved to pay for it.
 * Own-key and preview runs never need it; a saved access code or tester code skips it.
 */
export function needsRunChoice(kind: "mock" | "api" | "own", savedCode: string): boolean {
  return kind === "api" && !savedCode.trim();
}

/** The label on the code field: an access code once paid plans are on, the tester code before. */
export function codeFieldLabel(paid: boolean = paidPlansOn()): string {
  return paid ? "Access code" : "Tester code for real runs";
}
