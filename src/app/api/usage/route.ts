import { after, type NextRequest } from "next/server";
import { handleUsageBeacon } from "@/lib/usage/handler";

/** POST /api/usage: one anonymous count from this site's own pages (src/lib/usage). Always 204, no body. */
export async function POST(request: NextRequest) {
  const raw = (await request.text()).slice(0, 400);
  const headers = {
    host: request.headers.get("host"),
    origin: request.headers.get("origin"),
    secFetchSite: request.headers.get("sec-fetch-site"),
    userAgent: request.headers.get("user-agent"),
  };
  after(() => handleUsageBeacon(raw, headers));
  return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
}
