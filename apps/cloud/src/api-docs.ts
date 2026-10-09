import type { Hono } from "hono";
import { openApiSpec } from "./openapi.ts";
import type { CloudEnv } from "./types.ts";

// Static API reference: no inline script (CSP `script-src 'self'`), no third-party assets.
const page = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pig Agent API 文档</title>
<style>
body{font:14px/1.6 system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;margin:0;color:#1f2328;background:#fff}
header{padding:24px 32px;border-bottom:1px solid #d0d7de}main{padding:0 32px 48px;max-width:1100px}
h1{margin:0 0 4px;font-size:22px}h2{margin:32px 0 8px;font-size:18px;border-bottom:1px solid #d0d7de;padding-bottom:4px}
.op{border:1px solid #d0d7de;border-radius:6px;margin:8px 0}.op summary{cursor:pointer;padding:8px 12px;display:flex;gap:12px;align-items:center}
.m{font:600 12px ui-monospace,monospace;padding:2px 8px;border-radius:4px;color:#fff;min-width:52px;text-align:center}
.get{background:#0969da}.post{background:#1a7f37}.patch{background:#9a6700}.put{background:#8250df}.delete{background:#cf222e}
code,pre{font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}pre{background:#f6f8fa;padding:12px;border-radius:6px;overflow:auto;margin:8px 12px}
.body{padding:0 12px 12px}.muted{color:#59636e}a{color:#0969da}
</style></head>
<body><header><h1>Pig Agent API</h1><div class="muted">机器可读规范：<a href="/openapi.json">/openapi.json</a>（OpenAPI 3.1）</div></header>
<main id="root"><p class="muted">加载中…</p></main>
<script src="/api-docs.js"></script></body></html>`;

const script = `(async () => {
  const root = document.getElementById("root");
  const el = (tag, attrs = {}, ...children) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    for (const c of children) n.append(c);
    return n;
  };
  const pretty = (v) => JSON.stringify(v, null, 2);
  try {
    const spec = await (await fetch("/openapi.json")).json();
    root.textContent = "";
    root.append(el("p", {}, spec.info.description));
    const byTag = new Map(spec.tags.map((t) => [t.name, []]));
    for (const [path, ops] of Object.entries(spec.paths))
      for (const [method, op] of Object.entries(ops)) (byTag.get(op.tags[0]) || []).push({ path, method, op });
    for (const tag of spec.tags) {
      const ops = byTag.get(tag.name) || [];
      if (!ops.length) continue;
      root.append(el("h2", { id: "tag-" + tag.name }, tag.name + " · " + tag.description));
      for (const { path, method, op } of ops) {
        const body = el("div", { class: "body" });
        if (op.parameters?.length) body.append(el("pre", {}, "参数\\n" + pretty(op.parameters)));
        if (op.requestBody) body.append(el("pre", {}, "请求体\\n" + pretty(op.requestBody.content["application/json"].schema)));
        body.append(el("pre", {}, "响应\\n" + Object.entries(op.responses).map(([c, r]) => c + "  " + r.description).join("\\n")));
        root.append(el("details", { class: "op" },
          el("summary", {}, el("span", { class: "m " + method }, method.toUpperCase()), el("code", {}, path), el("span", { class: "muted" }, op.summary)),
          body));
      }
    }
    root.append(el("h2", {}, "数据结构"));
    for (const [name, schema] of Object.entries(spec.components.schemas)) {
      const d = el("details", { class: "op" }, el("summary", {}, el("code", {}, name)));
      if (schema.description) d.append(el("p", { class: "body" }, schema.description));
      d.append(el("pre", {}, pretty(schema)));
      root.append(d);
    }
  } catch (e) {
    root.textContent = "无法加载 /openapi.json：" + e;
  }
})();
`;

export function registerApiDocs(app: Hono<CloudEnv>) {
  app.get("/openapi.json", (c) => {
    c.header("Cache-Control", "public, max-age=300");
    c.header("Access-Control-Allow-Origin", "*");
    return c.json(openApiSpec());
  });
  app.get("/api-docs", (c) => {
    c.header("Cache-Control", "public, max-age=300");
    return c.html(page);
  });
  app.get("/api-docs.js", (c) => {
    c.header("Cache-Control", "public, max-age=300");
    c.header("Content-Type", "text/javascript; charset=utf-8");
    return c.body(script);
  });
}
