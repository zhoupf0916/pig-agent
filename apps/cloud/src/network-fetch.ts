import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { isIP } from "node:net";
import { z } from "zod";

export function publicIPv4(address: string): boolean {
  if (isIP(address) !== 4) return false;
  const [a, b, c] = address.split(".").map(Number);
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a! >= 224 ||
    (a === 169 && b === 254) ||
    (a === 172 && b! >= 16 && b! <= 31) ||
    (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) ||
    (a === 100 && b! >= 64 && b! <= 127) ||
    (a === 198 && (b === 18 || b === 19 || b === 51)) ||
    (a === 203 && b === 0 && c === 113)
  );
}
export function approvedUrl(raw: string): URL {
  const url = new URL(raw);
  if (
    url.protocol !== "https:" ||
    (url.port && url.port !== "443") ||
    url.username ||
    url.password ||
    url.hash
  )
    throw Error("仅支持无认证信息、无片段的 HTTPS 443 GET 地址");
  const host = url.hostname.toLowerCase();
  if (
    host === "localhost" ||
    !host.includes(".") ||
    /\.(local|localhost|internal|lan|home)$/.test(host) ||
    (isIP(host) && !publicIPv4(host)) ||
    host.startsWith("[")
  )
    throw Error("禁止访问内网、元数据或本机地址");
  return url;
}
export const networkRequestSchema = z
  .object({
    url: z
      .string()
      .max(4096)
      .refine((value) => {
        try {
          approvedUrl(value);
          return true;
        } catch {
          return false;
        }
      }, "只允许公网 HTTPS 443 URL"),
    method: z.literal("GET").default("GET"),
    timeoutMs: z.number().int().min(1000).max(15000).default(10000),
    maxBytes: z.number().int().min(1000).max(400000).default(200000),
  })
  .strict();
export type NetworkRequest = z.infer<typeof networkRequestSchema>;
export function publicDnsAddresses(value: unknown): string[] {
  const data=value as {Status?:number;Answer?:Array<{type:number;data:string}>};
  if(data?.Status!==0 || !Array.isArray(data.Answer))throw Error("公网 DNS 没有返回有效解析结果");
  const addresses=data.Answer.filter(item=>item.type===1).map(item=>item.data);
  if(!addresses.length || addresses.some(address=>!publicIPv4(address)))throw Error("公网 DNS 返回非公网或空地址");
  return addresses;
}
async function publicDnsLookup(host: string, signal: AbortSignal): Promise<string[]> {
  // Fixed, certificate-validated resolver IP; system/Fake-IP DNS is never used here.
  const url=new URL("https://1.1.1.1/dns-query");url.searchParams.set("name",host);url.searchParams.set("type","A");
  return new Promise((resolve,reject)=>{
    const req=request(url,{method:"GET",signal:AbortSignal.any([signal,AbortSignal.timeout(4000)]),headers:{Accept:"application/dns-json"}},res=>{
      if(res.statusCode!==200){res.destroy();reject(Error("公网 DNS 服务暂时不可用"));return;}
      let body="",bytes=0;
      res.on("data",(chunk:Buffer)=>{bytes+=chunk.length;if(bytes>16384){res.destroy();reject(Error("公网 DNS 响应超出限制"));return;}body+=chunk.toString("utf8");});
      res.on("end",()=>{try{resolve(publicDnsAddresses(JSON.parse(body)));}catch{reject(Error("公网 DNS 响应无效或包含非公网地址"));}});
      res.on("error",reject);
    });req.on("error",reject);req.end();
  });
}
export async function resolveNetworkAddress(host: string, signal: AbortSignal = new AbortController().signal): Promise<string> {
  const mode=process.env.NETWORK_DNS_MODE || "system";
  if(!["system","public"].includes(mode))throw Error("NETWORK_DNS_MODE 配置无效");
  const addresses=isIP(host)?[{address:host,family:4}]:mode==="public" ? (await publicDnsLookup(host,signal)).map(address=>({address,family:4})) : await lookup(host,{all:true});
  // Never fall back to a private address; TLS connection pins this vetted IPv4.
  if(addresses.some(a=>a.family===4&&!publicIPv4(a.address)))throw Error("域名解析包含非公网地址，请检查代理或 DNS 配置");
  const address=addresses.find(a=>a.family===4&&publicIPv4(a.address))?.address;
  if(!address)throw Error("目标没有可用的公网 IPv4 地址");
  return address;
}
async function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if(signal.aborted) throw Error("请求已取消");
  let onAbort:()=>void = ()=>{};
  try {
    return await Promise.race([work,new Promise<T>((_resolve,reject)=>{
      onAbort=()=>reject(Error("请求已取消或超时"));
      signal.addEventListener("abort",onAbort,{once:true});
      if(signal.aborted)onAbort();
    })]);
  } finally {signal.removeEventListener("abort",onAbort);}
}
export async function fetchApprovedNetwork(
  input: NetworkRequest,
  signal: AbortSignal,
) {
  const url = approvedUrl(input.url),
    address = await abortable(resolveNetworkAddress(url.hostname, signal), signal);
  if (signal.aborted) throw Error("请求已取消");
  return new Promise<{
    url: string;
    status: number;
    body: string;
    content_type: string;
    truncated: boolean;
    redirect?: string;
  }>((resolve, reject) => {
    const req = request(
      url,
      {
        method: "GET",
        signal,
        family: 4,
        lookup: (_host, _options, callback) => callback(null, address, 4),
        headers: {
          Accept: "text/plain,text/html,application/json",
          "Accept-Encoding": "identity",
          "User-Agent": "Pig-Agent-Approved-Fetch",
        },
      },
      (res) => {
        const status = res.statusCode || 0,
          type = String(res.headers["content-type"] || "");
        if (status >= 300 && status < 400) {
          res.destroy();
          let redirect = "";
          try { redirect = res.headers.location ? new URL(res.headers.location, url).toString() : ""; }
          catch { reject(Error("目标返回无效重定向地址")); return; }
          // Never silently spend an approval on a different URL, even on the same host.
          resolve({
            url: input.url,
            status,
            body: "目标返回重定向；新地址需要重新申请单次授权。",
            content_type: type,
            truncated: false,
            ...(redirect ? { redirect } : {}),
          });
          return;
        }
        const chunks: Buffer[] = [];
        let bytes = 0,
          settled = false;
        const finish = (truncated: boolean) => {
          if (settled) return;
          settled = true;
          resolve({
            url: input.url,
            status,
            body: Buffer.concat(chunks).toString("utf8"),
            content_type: type,
            truncated,
          });
        };
        res.on("data", (chunk: Buffer) => {
          const remaining = input.maxBytes - bytes;
          if (remaining > 0) {
            chunks.push(chunk.subarray(0, remaining));
            bytes += Math.min(remaining, chunk.length);
          }
          if (chunk.length > remaining) {
            finish(true);
            res.destroy();
          }
        });
        res.on("end", () => finish(false));
        res.on("error", (error) => {
          if (!settled) reject(error);
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}
