import { test } from "node:test";
import assert from "node:assert/strict";
import { toStrictSchema } from "@/lib/meta/strictSchema";
import { REASON_SCHEMA, COST_SCHEMA } from "@/lib/pipeline/planPrompts";
import { REVIEW_SCHEMA } from "@/lib/pipeline/review";

function problems(s: unknown, path = "$"): string[] {
  const out: string[] = [];
  if (!s || typeof s !== "object" || Array.isArray(s)) return out;
  const n = s as Record<string, unknown>;
  const props = n.properties as Record<string, unknown> | undefined;
  if (props) {
    if (n.additionalProperties !== false) out.push(`${path}: additionalProperties`);
    const req = (n.required as string[] | undefined) ?? [];
    for (const k of Object.keys(props)) if (!req.includes(k)) out.push(`${path}.${k}: not required`);
    for (const k of Object.keys(props)) out.push(...problems(props[k], `${path}.${k}`));
  }
  if (n.items) out.push(...problems(n.items, `${path}[]`));
  return out;
}

test("every pipeline schema is strict-valid once sent to Meta, and the originals are not changed", () => {
  const before = JSON.stringify([REASON_SCHEMA, COST_SCHEMA, REVIEW_SCHEMA]);
  for (const s of [REASON_SCHEMA, COST_SCHEMA, REVIEW_SCHEMA]) assert.deepEqual(problems(toStrictSchema(s)), []);
  assert.equal(JSON.stringify([REASON_SCHEMA, COST_SCHEMA, REVIEW_SCHEMA]), before);
});

test("an optional key becomes required and nullable; a required key is left alone", () => {
  const out = toStrictSchema({ type: "object", required: ["a"], properties: { a: { type: "string" }, b: { type: "string" } } }) as any;
  assert.deepEqual(out.required, ["a", "b"]);
  assert.deepEqual(out.properties.b.type, ["string", "null"]);
  assert.equal(out.properties.a.type, "string");
  assert.equal(out.additionalProperties, false);
});
