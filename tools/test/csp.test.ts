import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCsp, byokFlagOn, cspDirectives, META_API_ORIGIN } from "../../src/lib/csp";

test("production policy keeps every request on this site when own-key mode is off", () => {
  const d = cspDirectives({ byok: false, dev: false });
  assert.deepEqual(d["connect-src"], ["'self'", "blob:", "data:"]);
  assert.deepEqual(d["default-src"], ["'self'"]);
  assert.ok(!d["script-src"].includes("'unsafe-eval'"));
  assert.deepEqual(d["object-src"], ["'none'"]);
  assert.deepEqual(d["frame-ancestors"], ["'none'"]);
});

test("own-key mode adds the Meta API host and nothing else to connect-src", () => {
  const d = cspDirectives({ byok: true, dev: false });
  assert.deepEqual(d["connect-src"], ["'self'", "blob:", "data:", META_API_ORIGIN]);
  assert.equal(META_API_ORIGIN, "https://api.meta.ai");
});

test("no directive allows any host wildcard or plain http", () => {
  for (const opts of [{ byok: true, dev: false }, { byok: false, dev: false }]) {
    for (const values of Object.values(cspDirectives(opts))) {
      for (const v of values) {
        assert.ok(!v.includes("*"), v);
        assert.ok(!v.startsWith("http:"), v);
      }
    }
  }
});

test("dev adds eval and the reload socket only", () => {
  const d = cspDirectives({ byok: false, dev: true });
  assert.ok(d["script-src"].includes("'unsafe-eval'"));
  assert.ok(d["connect-src"].includes("ws:"));
});

test("buildCsp serialises directives and keeps the old framing/plugin/base/form rules", () => {
  const s = buildCsp({ byok: false, dev: false });
  for (const rule of ["frame-ancestors 'none'", "object-src 'none'", "base-uri 'self'", "form-action 'self'", "connect-src 'self' blob: data:"]) {
    assert.ok(s.includes(rule), rule);
  }
  assert.ok(!s.includes(META_API_ORIGIN));
});

test("byokFlagOn matches only on", () => {
  assert.equal(byokFlagOn("on"), true);
  assert.equal(byokFlagOn(" ON "), true);
  for (const v of [undefined, "", "off", "1", "true"]) assert.equal(byokFlagOn(v), false);
});
