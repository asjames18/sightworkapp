import { test } from "node:test";
import assert from "node:assert/strict";
import { EMAIL_PATTERN, normalizeEmail } from "../../src/lib/billing/email";

test("normalizeEmail trims and lower-cases a real address", () => {
  assert.equal(normalizeEmail("  Pat.Lee+church@Example.ORG "), "pat.lee+church@example.org");
  assert.ok(EMAIL_PATTERN.test("a@b.co"));
});

test("normalizeEmail refuses anything that isn't one plain address", () => {
  for (const v of [undefined, null, 7, {}, "", " ", "x", "x@y", "x@@y.com", "x y@z.com", '"x"@z.com', "x@z.com, y@z.com", `${"a".repeat(65)}@z.com`]) {
    assert.equal(normalizeEmail(v), null, String(v));
  }
});
