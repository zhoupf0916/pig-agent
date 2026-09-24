import { describe, expect, it, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
const mocks = vi.hoisted(() => ({ lookup: vi.fn(), request: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup: mocks.lookup }));
vi.mock("node:https", () => ({ request: mocks.request }));
import {
  approvedUrl,
  publicIPv4,
  fetchApprovedNetwork,
  networkRequestSchema,
  publicDnsAddresses,
  resolveNetworkAddress,
} from "./network-fetch.ts";
beforeEach(() => {
  mocks.lookup.mockReset();
  mocks.request.mockReset();
});
const input = networkRequestSchema.parse({
  url: "https://example.com/path",
  maxBytes: 1000,
});
function response(status = 200, body = "hello", location?: string) {
  mocks.lookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
  mocks.request.mockImplementation((_url, _options, done) => {
    const req = new EventEmitter();
    Object.assign(req, {
      end() {
        const res = new EventEmitter();
        Object.assign(res, {
          statusCode: status,
          headers: {
            "content-type": "text/plain",
            ...(location ? { location } : {}),
          },
          resume() {},
          destroy() {},
        });
        done(res);
        queueMicrotask(() => {
          res.emit("data", Buffer.from(body));
          res.emit("end");
        });
      },
    });
    return req;
  });
}
describe("single approved network GET", () => {
  it("rejects private, metadata, unsupported ports/protocols, credentials and IPv6", () => {
    for (const ip of [
      "127.0.0.1",
      "10.0.0.1",
      "172.16.0.1",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "224.0.0.1",
      "::ffff:127.0.0.1",
    ])
      expect(publicIPv4(ip)).toBe(false);
    for (const url of [
      "http://example.com",
      "https://127.0.0.1",
      "https://metadata.google.internal",
      "https://[::1]",
      "https://user:pass@example.com",
      "https://example.com:8443",
      "https://example.com/#fragment",
    ])
      expect(() => approvedUrl(url)).toThrow();
    expect(publicIPv4("93.184.216.34")).toBe(true);
    expect(publicIPv4("192.0.66.220")).toBe(true);
    expect(publicIPv4("198.51.42.8")).toBe(true);
    for (const ip of ["192.0.0.8", "192.0.2.1", "198.51.100.1"])
      expect(publicIPv4(ip)).toBe(false);
  });
  it("binds HTTPS socket DNS to vetted public address, forwards no secret headers, truncates response", async () => {
    response(200, "a".repeat(1100));
    const result = await fetchApprovedNetwork(
      input,
      new AbortController().signal,
    );
    expect(result.body).toHaveLength(1000);
    expect(result.truncated).toBe(true);
    const options = mocks.request.mock.calls[0]![1];
    const callback = vi.fn();
    options.lookup("example.com", {}, callback);
    expect(callback).toHaveBeenCalledWith(null, "93.184.216.34", 4);
    expect(options.headers.Authorization).toBeUndefined();
    expect(options.headers.Cookie).toBeUndefined();
    expect(options.method).toBe("GET");
    expect(options.agent).toBe(false);
  });
  it("denies private DNS resolutions before socket creation and does not follow redirects", async () => {
    mocks.lookup.mockResolvedValue([{ address: "10.1.2.3", family: 4 }]);
    await expect(
      fetchApprovedNetwork(input, new AbortController().signal),
    ).rejects.toThrow("非公网");
    expect(mocks.request).not.toHaveBeenCalled();
    response(302, "", "https://127.0.0.1/private");
    const result = await fetchApprovedNetwork(
      input,
      new AbortController().signal,
    );
    expect(result.redirect).toBe("https://127.0.0.1/private");
    expect(mocks.request).toHaveBeenCalledTimes(1);
    expect(result.body).toContain("重新申请");
  });
  it("does not connect after cancellation", async () => {
    response();
    const controller = new AbortController();
    controller.abort();
    await expect(
      fetchApprovedNetwork(input, controller.signal),
    ).rejects.toThrow();
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it("invalid redirect rejects safely and cancellation interrupts pending DNS", async () => {
    response(302, "", "https://[invalid");
    await expect(
      fetchApprovedNetwork(input, new AbortController().signal),
    ).rejects.toThrow("无效重定向");
    mocks.request.mockClear();
    mocks.lookup.mockImplementation(() => new Promise(() => {}));
    const controller = new AbortController();
    const work = fetchApprovedNetwork(input, controller.signal);
    controller.abort();
    await expect(work).rejects.toThrow("取消");
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it("public DNS mode validates fixed-resolver answers and never trusts private A records", async () => {
    expect(
      publicDnsAddresses({
        Status: 0,
        Answer: [{ type: 1, data: "93.184.216.34" }],
      }),
    ).toEqual(["93.184.216.34"]);
    expect(() =>
      publicDnsAddresses({
        Status: 0,
        Answer: [{ type: 1, data: "198.18.0.1" }],
      }),
    ).toThrow();
    expect(() => publicDnsAddresses({ Status: 3 })).toThrow();
    const original = process.env.NETWORK_DNS_MODE;
    process.env.NETWORK_DNS_MODE = "public";
    try {
      response(
        200,
        JSON.stringify({
          Status: 0,
          Answer: [{ type: 1, data: "93.184.216.34" }],
        }),
      );
      expect(await resolveNetworkAddress("example.com")).toBe("93.184.216.34");
      expect(mocks.lookup).not.toHaveBeenCalled();
      expect(String(mocks.request.mock.calls[0]![0])).toBe(
        "https://1.1.1.1/dns-query?name=example.com&type=A",
      );
    } finally {
      if (original === undefined) delete process.env.NETWORK_DNS_MODE;
      else process.env.NETWORK_DNS_MODE = original;
    }
  });
});

describe("网络故障可诊断并在连接发送前切换地址", () => {
  it("首个公网地址连接失败后使用第二个公网地址", async () => {
    mocks.lookup.mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
      { address: "93.184.216.35", family: 4 },
    ]);
    let attempts = 0;
    mocks.request.mockImplementation((_url, options, done) => {
      const req = new EventEmitter();
      Object.assign(req, {
        end() {
          attempts++;
          if (attempts === 1) {
            queueMicrotask(() =>
              req.emit(
                "error",
                Object.assign(new Error("connection refused"), {
                  code: "ECONNREFUSED",
                }),
              ),
            );
            return;
          }
          const cb = vi.fn();
          options.lookup("example.com", {}, cb);
          expect(cb).toHaveBeenCalledWith(null, "93.184.216.35", 4);
          const res = new EventEmitter();
          Object.assign(res, { statusCode: 200, headers: {}, destroy() {} });
          done(res);
          queueMicrotask(() => {
            res.emit("data", Buffer.from("second-address"));
            res.emit("end");
          });
        },
      });
      return req;
    });
    expect(
      (await fetchApprovedNetwork(input, new AbortController().signal)).body,
    ).toBe("second-address");
    expect(attempts).toBe(2);
  });
  it("DNS 故障有稳定错误码且不创建目标连接", async () => {
    mocks.lookup.mockRejectedValue(
      Object.assign(new Error("private diagnostic detail"), {
        code: "ENOTFOUND",
      }),
    );
    await expect(
      fetchApprovedNetwork(input, new AbortController().signal),
    ).rejects.toMatchObject({ code: "DNS_FAILED", phase: "dns" });
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it("TLS 已连接后响应中断不重放 GET", async () => {
    mocks.lookup.mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
      { address: "93.184.216.35", family: 4 },
    ]);
    mocks.request.mockImplementation((_url, _options, _done) => {
      const req = new EventEmitter();
      Object.assign(req, {
        end() {
          const socket = new EventEmitter();
          req.emit("socket", socket);
          socket.emit("secureConnect");
          queueMicrotask(() =>
            req.emit(
              "error",
              Object.assign(new Error("reset"), { code: "ECONNRESET" }),
            ),
          );
        },
      });
      return req;
    });
    await expect(
      fetchApprovedNetwork(input, new AbortController().signal),
    ).rejects.toMatchObject({ code: "CONNECTION_RESET" });
    expect(mocks.request).toHaveBeenCalledTimes(1);
  });
});

it("可选择国内可达的加密 DNS，固定解析器 IP 且保留 TLS 主机校验", async () => {
  const oldMode = process.env.NETWORK_DNS_MODE,
    oldProvider = process.env.NETWORK_DNS_PROVIDER;
  process.env.NETWORK_DNS_MODE = "public";
  process.env.NETWORK_DNS_PROVIDER = "alidns";
  try {
    response(
      200,
      JSON.stringify({
        Status: 0,
        Answer: [{ type: 1, data: "192.0.66.220" }],
      }),
    );
    expect(await resolveNetworkAddress("techcrunch.com")).toBe("192.0.66.220");
    const [url, options] = mocks.request.mock.calls[0]!;
    expect(String(url)).toBe(
      "https://dns.alidns.com/resolve?name=techcrunch.com&type=A",
    );
    const cb = vi.fn();
    options.lookup("dns.alidns.com", {}, cb);
    expect(cb).toHaveBeenCalledWith(null, "223.5.5.5", 4);
    expect(options.rejectUnauthorized).not.toBe(false);
    expect(mocks.lookup).not.toHaveBeenCalled();
  } finally {
    if (oldMode === undefined) delete process.env.NETWORK_DNS_MODE;
    else process.env.NETWORK_DNS_MODE = oldMode;
    if (oldProvider === undefined) delete process.env.NETWORK_DNS_PROVIDER;
    else process.env.NETWORK_DNS_PROVIDER = oldProvider;
  }
});

it("DNS 阶段也受请求总超时约束，不泄漏底层错误详情", async () => {
  vi.useFakeTimers();
  try {
    mocks.lookup.mockImplementation(() => new Promise(() => {}));
    const controller = new AbortController();
    const work = fetchApprovedNetwork(input, controller.signal);
    const assertion = expect(work).rejects.toMatchObject({
      code: "NETWORK_TIMEOUT",
      phase: "dns",
    });
    controller.abort(new DOMException("timeout", "TimeoutError"));
    await assertion;
    expect(mocks.request).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});
