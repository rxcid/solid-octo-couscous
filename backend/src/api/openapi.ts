/**
 * Moves every titled schema in the operations into components.schemas and
 * leaves a $ref in its place. @fastify/swagger inlines route schemas, which
 * would leave generated clients with anonymous nested types; a `title` in
 * schemas.ts is how a schema asks for a name.
 */
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Spec = { paths?: Json; components?: { schemas?: Record<string, Json> } & Record<string, Json> } & Record<string, unknown>;

export function withNamedSchemas<T>(input: T): T {
  const spec = structuredClone(input) as Spec;
  const named: Record<string, Json> = {};

  const hoist = (node: Json): Json => {
    if (Array.isArray(node)) return node.map(hoist);
    if (node === null || typeof node !== "object") return node;
    const schema = Object.fromEntries(Object.entries(node).map(([key, value]) => [key, hoist(value)]));
    // Only schemas carry a string title under `paths`; `properties.title` is an object.
    if (typeof schema.title !== "string") return schema;
    const name = schema.title;
    const existing = named[name];
    if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(schema)) {
      throw new Error(`Two different schemas are named ${name}; give one of them another title.`);
    }
    named[name] = schema;
    return { $ref: `#/components/schemas/${name}` };
  };

  spec.paths = hoist((spec.paths ?? {}) as Json);
  const sorted = Object.fromEntries(Object.entries(named).sort(([a], [b]) => a.localeCompare(b)));
  spec.components = { ...spec.components, schemas: { ...spec.components?.schemas, ...sorted } };
  return spec as T;
}

/**
 * Marks query parameters that have a default as optional. @fastify/swagger
 * copies them into `required` from the schema, but the server fills in a
 * missing one, so clients need not send it.
 */
export function withOptionalDefaults<T>(input: T): T {
  const spec = structuredClone(input) as { paths?: Record<string, Record<string, { parameters?: Json[] }>> };
  for (const operations of Object.values(spec.paths ?? {})) {
    for (const operation of Object.values(operations)) {
      for (const parameter of operation.parameters ?? []) {
        if (!parameter || typeof parameter !== "object" || Array.isArray(parameter)) continue;
        const schema = parameter.schema;
        const hasDefault = !!schema && typeof schema === "object" && !Array.isArray(schema) && "default" in schema;
        if (parameter.in === "query" && hasDefault) parameter.required = false;
      }
    }
  }
  return spec as T;
}

/** The document the server publishes: named schemas, defaulted parameters optional. */
export const publicDocument = <T>(spec: T): T => withOptionalDefaults(withNamedSchemas(spec));

const isNull = (schema: Json) =>
  !!schema && typeof schema === "object" && !Array.isArray(schema) && schema.type === "null";

/**
 * Adapts the document for swift-openapi-generator, which skips `null`
 * schemas and so drops every `anyOf: [T, {type: "null"}]` property outright.
 * Each such property becomes plain T and optional instead; Swift's Codable
 * decodes the server's explicit null to nil for an optional property, so the
 * wire format is unchanged. The served document keeps the precise form.
 */
export function forSwiftGenerator<T>(input: T): T {
  const visit = (node: Json): Json => {
    if (Array.isArray(node)) return node.map(visit);
    if (node === null || typeof node !== "object") return node;
    const schema = Object.fromEntries(Object.entries(node).map(([key, value]) => [key, visit(value)]));
    const properties = schema.properties;
    if (!properties || typeof properties !== "object" || Array.isArray(properties)) return schema;
    const optional = new Set<string>();
    for (const [name, property] of Object.entries(properties)) {
      if (!property || typeof property !== "object" || Array.isArray(property)) continue;
      const variants = Array.isArray(property.anyOf) ? property.anyOf : null;
      if (!variants?.some(isNull)) continue;
      const rest = variants.filter((v) => !isNull(v));
      if (rest.length !== 1 || !rest[0] || typeof rest[0] !== "object" || Array.isArray(rest[0])) continue;
      const { anyOf: _, ...annotations } = property;
      properties[name] = { ...annotations, ...rest[0] };
      optional.add(name);
    }
    if (optional.size && Array.isArray(schema.required)) {
      schema.required = schema.required.filter((name) => !optional.has(String(name)));
    }
    return schema;
  };
  return visit(structuredClone(input) as Json) as T;
}
