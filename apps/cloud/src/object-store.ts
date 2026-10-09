import { createHash, createHmac } from "node:crypto";

/**
 * Minimal S3 client (AWS Signature V4, path-style URLs) for MinIO / Tencent COS / AWS S3.
 * Only what the control plane needs: bucket bootstrap, put/get/head/delete and paged listing.
 */
export type S3Config = { endpoint: string; bucket: string; accessKey: string; secretKey: string; region?: string };
export type ListedObject = { key: string; size: number; lastModified: Date };

const sha256hex = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");
const hmac = (key: string | Buffer, data: string) => createHmac("sha256", key).update(data).digest();
/** RFC 3986 encoding as S3 expects (unreserved characters kept). */
export const s3Encode = (value: string) =>
  encodeURIComponent(value).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());

export class S3Error extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`S3 ${status} ${code}`);
  }
}

export class S3Client {
  private readonly endpoint: URL;
  private readonly region: string;
  constructor(private readonly config: S3Config) {
    this.endpoint = new URL(config.endpoint);
    this.region = config.region || "us-east-1";
  }
  get bucket() {
    return this.config.bucket;
  }

  /** Signs and sends one request. `key` undefined targets the bucket itself. */
  async request(method: string, key: string | undefined, opts: { query?: Record<string, string>; body?: Uint8Array; headers?: Record<string, string>; now?: Date; timeoutMs?: number } = {}) {
    const path = "/" + [this.config.bucket, ...(key === undefined ? [] : key.split("/"))].map(s3Encode).join("/");
    const query = Object.entries(opts.query ?? {})
      .map(([k, v]) => [s3Encode(k), s3Encode(v)])
      .sort(([a], [b]) => (a! < b! ? -1 : a! > b! ? 1 : 0))
      .map(([k, v]) => `${k}=${v}`)
      .join("&");
    const now = opts.now ?? new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
    const date = amzDate.slice(0, 8);
    const payloadHash = sha256hex(opts.body ?? new Uint8Array());
    const headers: Record<string, string> = {
      host: this.endpoint.host,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
      ...Object.fromEntries(Object.entries(opts.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v.trim()])),
    };
    const names = Object.keys(headers).sort();
    const canonical = [method, path, query, names.map((n) => `${n}:${headers[n]}\n`).join(""), names.join(";"), payloadHash].join("\n");
    const scope = `${date}/${this.region}/s3/aws4_request`;
    const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256hex(canonical)].join("\n");
    const key4 = hmac(hmac(hmac(hmac("AWS4" + this.config.secretKey, date), this.region), "s3"), "aws4_request");
    const signature = createHmac("sha256", key4).update(toSign).digest("hex");
    const { host: _host, ...sendHeaders } = headers;
    const url = new URL(path + (query ? "?" + query : ""), this.endpoint);
    return fetch(url, {
      method,
      headers: { ...sendHeaders, Authorization: `AWS4-HMAC-SHA256 Credential=${this.config.accessKey}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}` },
      body: opts.body,
      redirect: "error",
      signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
    });
  }

  private async check(r: Response, ok: number[] = [200]) {
    if (ok.includes(r.status)) return r;
    const text = await r.text().catch(() => "");
    throw new S3Error(r.status, /<Code>([^<]+)<\/Code>/.exec(text)?.[1] ?? "Unknown");
  }

  /** Creates the bucket if missing (idempotent). */
  async ensureBucket() {
    const head = await this.request("HEAD", undefined);
    await head.body?.cancel();
    if (head.status === 200) return;
    const r = await this.request("PUT", undefined);
    if (r.status === 409) return void (await r.body?.cancel()); // already owned
    await this.check(r);
  }
  async put(key: string, body: Uint8Array, contentType = "application/octet-stream") {
    const r = await this.check(await this.request("PUT", key, { body, headers: { "content-type": contentType } }));
    await r.body?.cancel();
  }
  /** Object bytes, or undefined when it does not exist. */
  async get(key: string): Promise<Buffer | undefined> {
    const r = await this.request("GET", key, { timeoutMs: 60_000 });
    if (r.status === 404) return void (await r.body?.cancel());
    await this.check(r);
    return Buffer.from(await r.arrayBuffer());
  }
  async head(key: string): Promise<{ size: number } | undefined> {
    const r = await this.request("HEAD", key);
    await r.body?.cancel();
    if (r.status === 404) return undefined;
    await this.check(r);
    return { size: Number(r.headers.get("content-length") ?? 0) };
  }
  async delete(key: string) {
    const r = await this.check(await this.request("DELETE", key), [200, 204]);
    await r.body?.cancel();
  }
  async *list(prefix: string): AsyncGenerator<ListedObject> {
    let token: string | undefined;
    do {
      const r = await this.check(await this.request("GET", undefined, { query: { "list-type": "2", prefix, "max-keys": "1000", ...(token ? { "continuation-token": token } : {}) } }));
      const xml = await r.text();
      for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
        const part = m[1]!;
        const key = decodeXml(/<Key>([\s\S]*?)<\/Key>/.exec(part)?.[1] ?? "");
        yield { key, size: Number(/<Size>(\d+)<\/Size>/.exec(part)?.[1] ?? 0), lastModified: new Date(/<LastModified>([^<]+)<\/LastModified>/.exec(part)?.[1] ?? 0) };
      }
      token = /<IsTruncated>true<\/IsTruncated>/.test(xml) ? decodeXml(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(xml)?.[1] ?? "") || undefined : undefined;
    } while (token);
  }
}

const decodeXml = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
