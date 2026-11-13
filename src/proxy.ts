import { NextResponse, type NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { billingEnabled, MAX_ACCESS_CODE_LENGTH } from "./lib/billing/accessCode";

/**
 * Tester-code gate for real runs. Every /api/** request (today: POST /api/plan, which spends Meta and
 * Baseten credits) must carry the x-sightwork-test-code header matching SIGHTWORK_TEST_CODE.
 * Fail closed: with no SIGHTWORK_TEST_CODE set on the server, every API request gets 401.
 * The demo (mock) runner never calls the API, so the public site is unaffected.
 */
const HEADER = "x-sightwork-test-code";

function matches(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Paid-plan routes (checkout and the like) spend no model credits and switch themselves off unless billing is on. */
const BILLING_ROUTE = /^\/api\/billing\/[a-z-]{1,40}$/;

const ACCESS_HEADER = "x-sightwork-access-code";

/**
 * A paid-plan run carries an access code instead of the tester code. The plan route checks the
 * code's signature and its Stripe status before reading the body, so the proxy only lets it
 * through when billing is on; with billing off, codes mean nothing and the tester gate applies.
 */
function paidRun(request: NextRequest): boolean {
  if (!billingEnabled(process.env.SIGHTWORK_BILLING)) return false;
  if (request.method !== "POST" || request.nextUrl.pathname !== "/api/plan") return false;
  const code = request.headers.get(ACCESS_HEADER)?.trim() ?? "";
  return code.startsWith("sw1.") && code.length <= MAX_ACCESS_CODE_LENGTH;
}

export function proxy(request: NextRequest) {
  if (BILLING_ROUTE.test(request.nextUrl.pathname)) return NextResponse.next();
  if (paidRun(request)) {
    console.log(JSON.stringify({ event: "sightwork_paid_run", path: request.nextUrl.pathname, at: new Date().toISOString() }));
    return NextResponse.next();
  }
  const expected = process.env.SIGHTWORK_TEST_CODE?.trim() ?? "";
  const given = request.headers.get(HEADER)?.trim() ?? "";
  if (!expected || !given || !matches(given, expected)) {
    return NextResponse.json(
      {
        error: expected
          ? "Real runs need a valid tester code."
          : "Real runs are switched off on this server.",
      },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }
  // One line per allowed real run in the server log (Vercel runtime logs), for the spend tally.
  if (request.method === "POST") {
    console.log(
      JSON.stringify({
        event: "sightwork_real_run",
        path: request.nextUrl.pathname,
        at: new Date().toISOString(),
      }),
    );
  }
  return NextResponse.next();
}

export const config = { matcher: "/api/:path*" };
