/**
 * Meta's Responses API refuses a strict json_schema unless every object lists every one of its keys in
 * `required`. Some of our schemas write an optional key the usual way (left out of `required`). This returns a
 * copy where each such key is required and may be null instead, so the same schema works on Meta without
 * changing what other providers are sent. A key that was already required is left alone.
 */
export function toStrictSchema<T>(schema: T): T {
  return strictify(schema) as T;
}

function strictify(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(strictify);
  if (node === null || typeof node !== "object") return node;
  const src = node as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(src)) {
    if (k === "properties" && v && typeof v === "object" && !Array.isArray(v)) {
      const props: Record<string, unknown> = {};
      for (const [pk, pv] of Object.entries(v as Record<string, unknown>)) props[pk] = strictify(pv);
      out[k] = props;
    } else out[k] = strictify(v);
  }
  const props = out.properties as Record<string, unknown> | undefined;
  if (props && typeof props === "object") {
    const keys = Object.keys(props);
    const required = Array.isArray(out.required) ? (out.required as string[]) : [];
    const missing = keys.filter((key) => !required.includes(key));
    if (missing.length > 0) {
      for (const key of missing) props[key] = nullable(props[key]);
      out.required = [...required, ...missing];
    }
    if (out.additionalProperties === undefined) out.additionalProperties = false;
  }
  return out;
}

function nullable(prop: unknown): unknown {
  if (!prop || typeof prop !== "object" || Array.isArray(prop)) return prop;
  const p = { ...(prop as Record<string, unknown>) };
  const t = p.type;
  if (typeof t === "string") p.type = t === "null" ? t : [t, "null"];
  else if (Array.isArray(t) && !t.includes("null")) p.type = [...t, "null"];
  return p;
}
