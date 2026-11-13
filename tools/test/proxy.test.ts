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
    assert.equal(paid("").status, 401);
    assert.equal(paid("garbage").status, 401);
    assert.equal(paid("sw1." + "a".repeat(600)).status, 401);
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
