import Link from "next/link";
import { byokEnabled } from "@/lib/client/byokKey";
import { paidPlansOn, PRICING_HREF, SETTINGS_HREF } from "@/lib/client/runAccess";

const ring = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";
const navLink = `inline-flex min-h-11 items-center rounded-lg px-2 text-sm font-semibold text-ink/80 underline-offset-4 hover:text-ink hover:underline ${ring}`;

/**
 * Header links to the two ways of paying for plans: Pricing (when paid plans are on) and Settings, where the
 * own Meta key goes (when own-key mode is on). Server-safe: both flags are public build-time values.
 * `compactOnPhone` hides the Settings link below sm, for headers that are already full on phones.
 */
export function AccessNavLinks({ compactOnPhone = false }: { compactOnPhone?: boolean }) {
  const paid = paidPlansOn();
  const byok = byokEnabled();
  if (!paid && !byok) return null;
  return (
    <nav aria-label="Plans and key" className="flex items-center gap-1" data-testid="access-nav">
      {paid && (
        <Link href={PRICING_HREF} className={navLink}>
          Pricing
        </Link>
      )}
      {byok && (
        <Link href={SETTINGS_HREF} className={`${navLink} ${compactOnPhone ? "hidden sm:inline-flex" : ""}`}>
          <span className="sm:hidden">Own key</span>
          <span className="hidden sm:inline">Use your own key</span>
        </Link>
      )}
    </nav>
  );
}
