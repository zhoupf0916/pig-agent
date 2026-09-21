// Local UI development surface; all API requests reach the real isolated cluster.
import http from "node:http";
import { readFile } from "node:fs/promises";
const assets = {
  "/admin/": "apps/admin/public/index.html",
  "/admin/index.html": "apps/admin/public/index.html",
  "/admin/app.js": "apps/admin/public/app.js",
  "/admin/style.css": "apps/admin/public/style.css",
  "/admin/tokens.css": "packages/design/tokens.css",
};
http
  .createServer(async (req, res) => {
    try {
      const path = new URL(req.url, "http://localhost").pathname;
      if (assets[path]) {
        res.setHeader(
          "Content-Type",
          path.endsWith(".css")
            ? "text/css"
            : path.endsWith(".js")
              ? "text/javascript"
              : "text/html",
        );
        res.end(await readFile(assets[path]));
        return;
      }
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const headers = { ...req.headers };
      delete headers.host;
      delete headers.connection;
      delete headers["content-length"];
      const upstream = await fetch("http://127.0.0.1:8892" + req.url, {
        method: req.method,
        headers,
        body: ["GET", "HEAD"].includes(req.method)
          ? undefined
          : Buffer.concat(chunks),
        signal: AbortSignal.timeout(30000),
      });
      res.statusCode = upstream.status;
      res.setHeader(
        "Content-Type",
        upstream.headers.get("content-type") || "application/json",
      );
      res.end(Buffer.from(await upstream.arrayBuffer()));
    } catch {
      res.statusCode = 502;
      res.end("Isolated control-plane unavailable");
    }
  })
  .listen(8896, "127.0.0.1", () =>
    console.log(
      "Admin UI preview http://127.0.0.1:8896/admin/; API -> isolated8892",
    ),
  );
