// Minimal JSON Schema subset for parallel subtask outputs. Supported keywords: type (string or list),
// properties, required, additionalProperties (boolean), items, enum, const, minimum, maximum,
// minLength, maxLength, minItems, maxItems. Unknown keywords are rejected when the schema is accepted,
// so a schema never silently validates less than the model was told.
export type Schema = Record<string, unknown>;
const KEYWORDS = new Set(["type", "properties", "required", "additionalProperties", "items", "enum", "const", "minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems", "description", "title"]);
const TYPES = new Set(["object", "array", "string", "number", "integer", "boolean", "null"]);

/** Returns an error message when the schema uses something this validator cannot enforce. */
export function checkSchema(schema: unknown, path = "$", depth = 0): string | undefined {
  if (depth > 8) return `${path}: 嵌套过深（最多 8 层）`;
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return `${path}: schema 必须是对象`;
  const s = schema as Schema;
  for (const key of Object.keys(s)) if (!KEYWORDS.has(key)) return `${path}: 不支持的关键字 ${key}`;
  const types = s.type === undefined ? [] : Array.isArray(s.type) ? s.type : [s.type];
  for (const t of types) if (typeof t !== "string" || !TYPES.has(t)) return `${path}: 未知类型 ${String(t)}`;
  if (s.properties !== undefined) {
    if (!s.properties || typeof s.properties !== "object" || Array.isArray(s.properties)) return `${path}.properties: 必须是对象`;
    for (const [k, v] of Object.entries(s.properties as Schema)) {
      const e = checkSchema(v, `${path}.${k}`, depth + 1);
      if (e) return e;
    }
  }
  if (s.required !== undefined && (!Array.isArray(s.required) || s.required.some((r) => typeof r !== "string"))) return `${path}.required: 必须是字符串数组`;
  if (s.additionalProperties !== undefined && typeof s.additionalProperties !== "boolean") return `${path}.additionalProperties: 只支持 true/false`;
  if (s.items !== undefined) {
    const e = checkSchema(s.items, `${path}[]`, depth + 1);
    if (e) return e;
  }
  if (s.enum !== undefined && (!Array.isArray(s.enum) || !s.enum.length)) return `${path}.enum: 必须是非空数组`;
  for (const k of ["minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems"]) if (s[k] !== undefined && typeof s[k] !== "number") return `${path}.${k}: 必须是数字`;
  return undefined;
}

function typeOf(v: unknown) {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

/** Validates `value`; returns up to `limit` human-readable errors (empty when valid). */
export function validate(schema: Schema, value: unknown, path = "$", errors: string[] = [], limit = 10): string[] {
  if (errors.length >= limit) return errors;
  const types = schema.type === undefined ? [] : Array.isArray(schema.type) ? (schema.type as string[]) : [schema.type as string];
  if (types.length) {
    const actual = typeOf(value);
    const ok = types.some((t) => t === actual || (t === "integer" && actual === "number" && Number.isInteger(value)) || (t === "number" && actual === "number"));
    if (!ok) { errors.push(`${path}: 应为 ${types.join("|")}，实际为 ${actual}`); return errors; }
  }
  if (schema.const !== undefined && JSON.stringify(schema.const) !== JSON.stringify(value)) errors.push(`${path}: 应等于 ${JSON.stringify(schema.const)}`);
  if (Array.isArray(schema.enum) && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) errors.push(`${path}: 应为 ${schema.enum.map((e) => JSON.stringify(e)).join(" / ")} 之一`);
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) errors.push(`${path}: 应 ≥ ${schema.minimum}`);
    if (typeof schema.maximum === "number" && value > schema.maximum) errors.push(`${path}: 应 ≤ ${schema.maximum}`);
  }
  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && [...value].length < schema.minLength) errors.push(`${path}: 长度应 ≥ ${schema.minLength}`);
    if (typeof schema.maxLength === "number" && [...value].length > schema.maxLength) errors.push(`${path}: 长度应 ≤ ${schema.maxLength}`);
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) errors.push(`${path}: 至少 ${schema.minItems} 项`);
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) errors.push(`${path}: 至多 ${schema.maxItems} 项`);
    if (schema.items) value.forEach((v, i) => validate(schema.items as Schema, v, `${path}[${i}]`, errors, limit));
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    for (const r of (schema.required as string[] | undefined) ?? []) if (!(r in obj)) errors.push(`${path}: 缺少必填字段 ${r}`);
    const props = (schema.properties as Record<string, Schema> | undefined) ?? {};
    for (const [k, v] of Object.entries(obj)) {
      if (props[k]) validate(props[k], v, `${path}.${k}`, errors, limit);
      else if (schema.additionalProperties === false) errors.push(`${path}: 不允许的字段 ${k}`);
    }
  }
  return errors.slice(0, limit);
}

/** Extracts one JSON value from a model answer: the whole text, a ```json fence, or the outermost {…}/[…]. */
export function extractJson(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  const candidates: string[] = [text.trim()];
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fence) candidates.push(fence[1]!.trim());
  for (const [open, close] of [["{", "}"], ["[", "]"]] as const) {
    const a = text.indexOf(open), b = text.lastIndexOf(close);
    if (a >= 0 && b > a) candidates.push(text.slice(a, b + 1));
  }
  for (const c of candidates) {
    if (!c) continue;
    try { return { ok: true, value: JSON.parse(c) }; } catch { /* next */ }
  }
  return { ok: false, error: "回答中没有可解析的 JSON" };
}
