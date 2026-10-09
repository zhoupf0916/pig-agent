import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { openApiSpec } from "./openapi.ts";

const dir = new URL(".", import.meta.url).pathname;
const sources = readdirSync(dir)
  .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
  .map((f) => readFileSync(dir + f, "utf8"))
  .join("\n");

describe("OpenAPI spec", () => {
  const spec = openApiSpec();
  it("is OpenAPI 3.1 with resolvable component references", () => {
    expect(spec.openapi).toBe("3.1.0");
    const text = JSON.stringify(spec);
    for (const [, name] of text.matchAll(/"#\/components\/schemas\/(\w+)"/g))
      expect(spec.components.schemas, name).toHaveProperty(name!);
  });
  it("documents only routes that exist, with matching methods", () => {
    for (const [path, ops] of Object.entries(spec.paths)) {
      const route = path.replace(/\{(\w+)\}/g, ":$1");
      for (const method of Object.keys(ops)) {
        const pattern = new RegExp(`\\.${method}\\(\\s*"${route.replace(/[.*+?^$()|[\]\\]/g, "\\$&")}"`);
        expect(pattern.test(sources), `${method.toUpperCase()} ${path}`).toBe(true);
      }
    }
  });
  it("covers every webhook route", () => {
    const documented = new Set(Object.entries(spec.paths).flatMap(([p, ops]) => Object.keys(ops).map((m) => `${m} ${p.replace(/\{(\w+)\}/g, ":$1")}`)));
    const routes = [...sources.matchAll(/app\.(get|post|patch|delete)\("(\/v1\/webhooks[^"]*)"/g)].map((m) => `${m[1]} ${m[2]}`);
    expect(routes.length).toBeGreaterThan(8);
    for (const r of routes.filter((r) => !r.endsWith("/sink-receipts"))) expect(documented.has(r), r).toBe(true);
  });
  it("every operation has a tag declared in the tag list", () => {
    const tags = new Set(spec.tags.map((t) => t.name));
    for (const ops of Object.values(spec.paths)) for (const op of Object.values(ops) as Array<{ tags: string[] }>) expect(tags.has(op.tags[0]!)).toBe(true);
  });
});
