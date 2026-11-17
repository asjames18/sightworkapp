// Sends one anonymous count to this site (/api/usage). Only on builds where counting is set up
// (NEXT_PUBLIC_SIGHTWORK_USAGE=on, set from the server config in next.config.ts), and never when the
// browser asks sites not to track (Global Privacy Control or Do Not Track) or is driven by automation.
// No cookie, no stored id, nothing read from the device beyond the window width's rough class.
import { deviceFromWidth, type UsageEvent } from "@/lib/usage/events";
import type { PlanJobRunner } from "./planJob";

type Nav = { globalPrivacyControl?: boolean; doNotTrack?: string | null; webdriver?: boolean; sendBeacon?: (url: string, data: string) => boolean };

export function usageOn(flag: string | undefined = process.env.NEXT_PUBLIC_SIGHTWORK_USAGE): boolean {
  return flag === "on";
}

/** The visitor's browser asked not to be tracked, or a script is driving it. */
export function optedOut(nav: Nav | undefined): boolean {
  if (!nav) return true;
  return nav.globalPrivacyControl === true || nav.doNotTrack === "1" || nav.webdriver === true;
}

/** The beacon's body: event, detail and device class, nothing else. */
export function beaconBody(event: UsageEvent, detail: string, width: number | undefined): string {
  return JSON.stringify({ e: event, d: detail, v: deviceFromWidth(width) });
}

export function sendUsage(event: UsageEvent, detail: string, flag?: string): void {
  if (typeof window === "undefined" || !usageOn(flag)) return;
  const nav = navigator as unknown as Nav;
  if (optedOut(nav)) return;
  const body = beaconBody(event, detail, window.innerWidth);
  try {
    if (nav.sendBeacon?.("/api/usage", body)) return;
    void fetch("/api/usage", { method: "POST", body, keepalive: true, credentials: "omit" }).catch(() => {});
  } catch {
    /* counting never gets in the way */
  }
}

/**
 * Wraps a runner so a run counts as started, then done or failed, by how it ran ("byok" on the
 * visitor's own key, "code" on SightWork's server). Only the outcome is counted, never the plan.
 */
export function countedRun(mode: "byok" | "code", runner: PlanJobRunner, send: (e: UsageEvent, d: string) => void = sendUsage): PlanJobRunner {
  return async (input) => {
    send("plan_started", mode);
    let ended = false;
    const end = (e: "plan_done" | "plan_failed") => {
      if (ended) return;
      ended = true;
      send(e, mode);
    };
    try {
      await runner({
        ...input,
        onStatus: (s) => {
          if (!input.signal.aborted && s.state === "done") end("plan_done");
          else if (!input.signal.aborted && s.state === "failed") end("plan_failed");
          input.onStatus(s);
        },
      });
    } catch (err) {
      if (!input.signal.aborted) end("plan_failed");
      throw err;
    }
  };
}
