// Maintenance-only diagnostic: run with `node --import tsx scripts/probe-network.mjs URL...`.
// This is not an agent tool and does not grant task network permissions.
import { fetchApprovedNetwork, networkRequestSchema } from "../apps/cloud/src/network-fetch.ts";
const urls = process.argv.slice(2);
if (!urls.length) { console.error("Usage: node --import tsx scripts/probe-network.mjs https://example.com/"); process.exit(2); }
for (const url of urls) {
  const started = Date.now();
  let host = "invalid";
  try {
    const input = networkRequestSchema.parse({ url, maxBytes: 1000, timeoutMs: 10000 });
    host = new URL(input.url).hostname;
    const result = await fetchApprovedNetwork(input, new AbortController().signal);
    console.log(JSON.stringify({ host, status: result.status, elapsedMs: Date.now() - started, dnsMode: process.env.NETWORK_DNS_MODE || "system", dnsProvider: process.env.NETWORK_DNS_PROVIDER || "cloudflare" }));
  } catch (error) {
    console.log(JSON.stringify({ host, code: error.code || "INVALID_REQUEST", phase: error.phase, elapsedMs: Date.now() - started }));
    process.exitCode = 1;
  }
}
