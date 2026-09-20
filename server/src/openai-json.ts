import { z } from "zod";

type JsonSchema = Record<string, unknown>;

// Keywords OpenAI's strict validator rejects. Dropping them loses nothing: the reply
// is re-parsed with the same zod schema, so the limits still apply on the way out.
const UNSUPPORTED = [
  "maxItems", "minItems", "maxLength", "minLength",
  "pattern", "format", "default", "maximum", "minimum",
];

function harden(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(harden);
  if (!node || typeof node !== "object") return node;

  const out: JsonSchema = {};
  for (const [key, value] of Object.entries(node as JsonSchema)) {
    if (UNSUPPORTED.includes(key)) continue;
    out[key] = harden(value);
  }

  // Strict mode demands every property be required and no extras be allowed.
  // Optionality is expressed as a nullable type, which is why the planner schema
  // uses .nullable() rather than .optional() throughout.
  if (out.type === "object" && out.properties && typeof out.properties === "object") {
    out.required = Object.keys(out.properties as JsonSchema);
    out.additionalProperties = false;
  }
  return out;
}

/** A zod schema as JSON Schema that OpenAI will accept with `strict: true`. */
export function strictJsonSchema(schema: z.ZodType): JsonSchema {
  return harden(z.toJSONSchema(schema)) as JsonSchema;
}
