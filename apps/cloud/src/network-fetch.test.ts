import { describe, expect, it, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
const mocks=vi.hoisted(()=>({lookup:vi.fn(),request:vi.fn()}));
vi.mock("node:dns/promises",()=>({lookup:mocks.lookup}));
vi.mock("node:https",()=>({request:mocks.request}));
import {approvedUrl,publicIPv4,fetchApprovedNetwork,networkRequestSchema,publicDnsAddresses,resolveNetworkAddress} from "./network-fetch.ts";
beforeEach(()=>{mocks.lookup.mockReset();mocks.request.mockReset();});
const input=networkRequestSchema.parse({url:"https://example.com/path",maxBytes:1000});
function response(status=200,body="hello",location?:string){
 mocks.lookup.mockResolvedValue([{address:"93.184.216.34",family:4}]);
 mocks.request.mockImplementation((_url,_options,done)=>{const req=new EventEmitter();Object.assign(req,{end(){const res=new EventEmitter();Object.assign(res,{statusCode:status,headers:{"content-type":"text/plain",...(location?{location}:{})},resume(){},destroy(){}});done(res);queueMicrotask(()=>{res.emit("data",Buffer.from(body));res.emit("end");});}});return req;});
}
describe("single approved network GET",()=>{
 it("rejects private, metadata, unsupported ports/protocols, credentials and IPv6",()=>{
   for(const ip of ["127.0.0.1","10.0.0.1","172.16.0.1","192.168.1.1","169.254.169.254","100.64.0.1","224.0.0.1","::ffff:127.0.0.1"])expect(publicIPv4(ip)).toBe(false);
   for(const url of ["http://example.com","https://127.0.0.1","https://metadata.google.internal","https://[::1]","https://user:pass@example.com","https://example.com:8443","https://example.com/#fragment"])expect(()=>approvedUrl(url)).toThrow();
   expect(publicIPv4("93.184.216.34")).toBe(true);
 });
 it("binds HTTPS socket DNS to vetted public address, forwards no secret headers, truncates response",async()=>{
   response(200,"a".repeat(1100));const result=await fetchApprovedNetwork(input,new AbortController().signal);expect(result.body).toHaveLength(1000);expect(result.truncated).toBe(true);
   const options=mocks.request.mock.calls[0]![1];const callback=vi.fn();options.lookup("example.com",{},callback);expect(callback).toHaveBeenCalledWith(null,"93.184.216.34",4);expect(options.headers.Authorization).toBeUndefined();expect(options.headers.Cookie).toBeUndefined();expect(options.method).toBe("GET");
 });
 it("denies private DNS resolutions before socket creation and does not follow redirects",async()=>{
   mocks.lookup.mockResolvedValue([{address:"10.1.2.3",family:4}]);await expect(fetchApprovedNetwork(input,new AbortController().signal)).rejects.toThrow("非公网");expect(mocks.request).not.toHaveBeenCalled();
   response(302,"","https://127.0.0.1/private");const result=await fetchApprovedNetwork(input,new AbortController().signal);expect(result.redirect).toBe("https://127.0.0.1/private");expect(mocks.request).toHaveBeenCalledTimes(1);expect(result.body).toContain("重新申请");
 });
 it("does not connect after cancellation",async()=>{response();const controller=new AbortController();controller.abort();await expect(fetchApprovedNetwork(input,controller.signal)).rejects.toThrow();expect(mocks.request).not.toHaveBeenCalled();});
 it("invalid redirect rejects safely and cancellation interrupts pending DNS",async()=>{
   response(302,"","https://[invalid");await expect(fetchApprovedNetwork(input,new AbortController().signal)).rejects.toThrow("无效重定向");
   mocks.request.mockClear();mocks.lookup.mockImplementation(()=>new Promise(()=>{}));const controller=new AbortController();const work=fetchApprovedNetwork(input,controller.signal);controller.abort();await expect(work).rejects.toThrow("取消");expect(mocks.request).not.toHaveBeenCalled();
 });

 it("public DNS mode validates fixed-resolver answers and never trusts private A records",async()=>{
   expect(publicDnsAddresses({Status:0,Answer:[{type:1,data:"93.184.216.34"}]})).toEqual(["93.184.216.34"]);
   expect(()=>publicDnsAddresses({Status:0,Answer:[{type:1,data:"198.18.0.1"}]})).toThrow();
   expect(()=>publicDnsAddresses({Status:3})).toThrow();
   const original=process.env.NETWORK_DNS_MODE;process.env.NETWORK_DNS_MODE="public";
   try{response(200,JSON.stringify({Status:0,Answer:[{type:1,data:"93.184.216.34"}]}));expect(await resolveNetworkAddress("example.com")).toBe("93.184.216.34");expect(mocks.lookup).not.toHaveBeenCalled();expect(String(mocks.request.mock.calls[0]![0])).toBe("https://1.1.1.1/dns-query?name=example.com&type=A");}
   finally{if(original===undefined)delete process.env.NETWORK_DNS_MODE;else process.env.NETWORK_DNS_MODE=original;}
 });

});
