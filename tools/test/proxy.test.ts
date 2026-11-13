/** The tester-code gate in src/proxy.ts: real runs cost money, so /api/** must fail closed. */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { proxy, config } from "@/proxy";

const ENV = "SIGHTWORK_TEST_CODE";
const saved = process.env[ENV];
afterEach(() => {
  if (saved === undefined) delete process.env[ENV];
  else process.env[ENV] = saved;
});

const req = (code?: string, method = "POST") =>
  new NextRequest("http://localhost/api/plan", {
    method,
    headers: code === undefined ? {} : { "x-sightwork-test-code": code },
  });
const quiet = <T>(fn: () => T): T => {
  const log = console.log;
  console.log = () => {};
  try {
    return fn();
  } finally {
    console.log = log;
  }
};

test("only /api/** is gated", () => {
  assert.equal(config.matcher, "/api/:path*");
});

test("fails closed when the server has no code set", () => {
  delete process.env[ENV];
  for (const c of [undefined, "", "anything"])
    assert.equal(proxy(req(c)).status, 401);
  process.env[ENV] = "   ";
  assert.equal(proxy(req("   ")).status, 401);
});

test("rejects a missing or wrong code, without caching", () => {
  process.env[ENV] = "right-code";
  for (const c of [undefined, "", "wrong", "right-cod", "right-code-x"]) {
    const res = proxy(req(c));
    assert.equal(res.status, 401, String(c));
    assert.equal(res.headers.get("cache-control"), "no-store");
  }
});

test("lets the right code through (trimmed)", () => {
  process.env[ENV] = "right-code";
  const res = quiet(() => proxy(req("  right-code ")));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-middleware-next"), "1");
});

test("billing routes skip the tester gate; look-alike paths and other routes stay gated", () => {
  delete process.env[ENV];
  const at = (path: string) =>
    quiet(() =>
      proxy(new NextRequest(`http://localhost${path}`, { method: "POST" })),
    );
  assert.equal(at("/api/billing/checkout").status, 200);
  for (const path of [
    "/api/plan",
    "/api/billing",
    "/api/billing/",
    "/api/billing/checkout/x",
    "/api/billingx/checkout",
    "/api/BILLING/checkout",
  ]) {
    assert.equal(at(path).status, 401, path);
  }
});

test("access-code runs skip the tester gate only when billing is on", () => {
  const BILL = "SIGHTWORK_BILLING";
  const savedBill = process.env[BILL];
  process.env[ENV] = "right-code";
  const paid = (code: string, opts: { method?: string; path?: string } = {}) =>
    quiet(() =>
      proxy(
        new NextRequest(`http://localhost${opts.path ?? "/api/plan"}`, {
          method: opts.method ?? "POST",
          headers: { "x-sightwork-access-code": code },
        }),
      ),
    );
  try {
    delete process.env[BILL];
    assert.equal(paid("sw1.a.b").status, 401, "billing off: a code is not a pass");
    process.env[BILL] = "yes";
    assert.equal(paid("sw1.a.b").status, 401, "only the exact on value counts");
    process.env[BILL] = "on";
    assert.equal(paid("sw1.a.b").status, 200);
    assert.equal(paid("  sw1.a.b ").status, 200);
    // Billing on: a POST plan run without a well-formed code needs a paid plan (402), not a tester code.
    assert.equal(paid("").status, 402);
    assert.equal(paid("garbage").status, 402);
    assert.equal(paid("sw1." + "a".repeat(600)).status, 402);
    assert.equal(paid("sw1.a.b", { method: "GET" }).status, 401);
    assert.equal(paid("sw1.a.b", { path: "/api/other" }).status, 401);
    assert.equal(paid("sw1.a.b", { path: "/api/transcribe" }).status, 200, "transcribe checks the code itself");
    assert.equal(paid("sw1.a.b", { path: "/api/transcribe", method: "GET" }).status, 401);
    delete process.env[ENV];
    assert.equal(paid("sw1.a.b").status, 200, "works with no tester code on the server");
  } finally {
    if (savedBill === undefined) delete process.env[BILL];
    else process.env[BILL] = savedBill;
  }
});

test("with billing on, the tester code no longer opens a plan or transcribe run", () => {
  const BILL = "SIGHTWORK_BILLING";
  const savedBill = process.env[BILL];
  process.env[ENV] = "right-code";
  const tester = (path: string, method = "POST") =>
    quiet(() =>
      proxy(
        new NextRequest(`http://localhost${path}`, {
          method,
          headers: { "x-sightwork-test-code": "right-code" },
        }),
      ),
    );
  try {
    delete process.env[BILL];
    assert.equal(tester("/api/plan").status, 200, "billing off: the tester code still opens a run");
    assert.equal(tester("/api/transcribe").status, 200);
    process.env[BILL] = "on";
    for (const path of ["/api/plan", "/api/transcribe"]) {
      const res = tester(path);
      assert.equal(res.status, 402, path);
      assert.equal(res.headers.get("cache-control"), "no-store");
    }
    assert.equal(quiet(() => proxy(req())).status, 402, "no codes at all: a paid plan is needed");
    assert.equal(tester("/api/other").status, 200, "other routes keep the tester gate");
    assert.equal(tester("/api/plan", "GET").status, 200, "only POST runs are paid");
    const both = quiet(() =>
      proxy(
        new NextRequest("http://localhost/api/plan", {
          method: "POST",
          headers: { "x-sightwork-test-code": "right-code", "x-sightwork-access-code": "sw1.a.b" },
        }),
      ),
    );
    assert.equal(both.status, 200, "an access code still goes through to the route's own check");
  } finally {
    if (savedBill === undefined) delete process.env[BILL];
    else process.env[BILL] = savedBill;
  }
});
