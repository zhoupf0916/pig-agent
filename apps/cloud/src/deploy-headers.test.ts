import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Production nginx (infra/tencent/nginx.conf) allows the single inline <script> in index.html by hash.
const repo = join(__dirname, "..", "..", "..");
const nginx = readFileSync(join(repo, "infra/tencent/nginx.conf"), "utf8");
const html = readFileSync(join(repo, "apps/web/index.html"), "utf8");
const PROXY_ROOT = "    location / {\n        proxy_pass";
const headers = (block: string) =>
  [...block.matchAll(/^\s*add_header (Strict-Transport-Security|Content-Security-Policy|Permissions-Policy|X-Content-Type-Options|Referrer-Policy|X-Frame-Options) (.*);$/gm)].map((m) => `${m[1]} ${m[2]}`);

describe("production security headers", () => {
  it("CSP allows exactly the inline scripts in apps/web/index.html", () => {
    const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(
      (m) => `'sha256-${createHash("sha256").update(m[1]!).digest("base64")}'`,
    );
    expect(inline.length).toBeGreaterThan(0);
    const policies = [...nginx.matchAll(/Content-Security-Policy "([^"]+)"/g)].map((m) => m[1]!);
    expect(policies.length).toBe(2);
    for (const policy of policies) {
      const scriptSrc = policy.split(";").map((d) => d.trim()).find((d) => d.startsWith("script-src"))!;
      expect(scriptSrc.split(/\s+/).filter((t) => t.startsWith("'sha256-")).sort()).toEqual(inline.sort());
      expect(scriptSrc).not.toContain("'unsafe-inline'");
      expect(policy).toContain("frame-ancestors 'none'");
    }
  });
  it("repeats server-level security headers inside locations that set their own headers", () => {
    const assets = nginx.slice(nginx.indexOf("location ^~ /assets/"), nginx.indexOf(PROXY_ROOT));
    const server = nginx.slice(nginx.indexOf("listen 443"), nginx.indexOf("location ^~ /internal/"));
    expect(headers(server).length).toBe(6);
    expect(headers(assets)).toEqual(headers(server));
  });
  it("rate-limits every password entry point, including the demo login", () => {
    expect(nginx).toMatch(/\$pig_auth_ip \{[^}]*\(login\|register\|invite\|demo\)/);
  });
  it("enables HTTP/2 and only compresses static assets", () => {
    // server_tokens belongs in /etc/nginx/nginx.conf: Ubuntu already declares it there, and a second
    // http-level server_tokens from this included file is a duplicate directive that fails nginx -t.
    expect(nginx).not.toMatch(/^\s*server_tokens/m);
    expect(nginx).toMatch(/^\s+http2 on;$/m);
    expect((nginx.match(/gzip on;/g) || []).length).toBe(1);
    const api = nginx.slice(nginx.indexOf(PROXY_ROOT));
    expect(api).not.toContain("gzip");
    expect(api).toContain("proxy_buffering off;");
  });
});
