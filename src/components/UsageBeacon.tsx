"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { sendUsage, usageOn } from "@/lib/client/usage";
import { pageKey } from "@/lib/usage/events";

/** Counts one page view per page opened, as an anonymous daily total (src/lib/usage). Renders nothing. */
export function UsageBeacon() {
  const path = usePathname();
  useEffect(() => {
    if (!usageOn()) return;
    const key = pageKey(path);
    if (key) sendUsage("view", key);
  }, [path]);
  return null;
}
