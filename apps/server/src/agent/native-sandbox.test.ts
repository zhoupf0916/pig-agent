import { describe,it,expect } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nativeCommand, seatbeltProfile, toolEnvironment, seccompFilter, linuxSandboxArgs } from "./native-sandbox.ts";
const run=(root:string,command:string)=>new Promise<{code:number|null;out:string}>(resolve=>{const x=nativeCommand(root,command);let out="";x.child.stdout!.on("data",c=>out+=String(c));x.child.stderr!.on("data",c=>out+=String(c));x.child.on("close",code=>{x.cleanup();resolve({code,out})})});
describe("native sandbox",()=>{
 it("only forwards deliberate tool environment",()=>{process.env.PIG_TEST_SECRET="no";expect(toolEnvironment("/work")).not.toHaveProperty("PIG_TEST_SECRET");delete process.env.PIG_TEST_SECRET;expect(toolEnvironment("/work").HOME).toBe("/work")});
 it("rejects unsupported seccomp ABI",()=>{expect(()=>seccompFilter("ia32")).toThrow();expect(seccompFilter("arm64").length%8).toBe(0)});
 it("shares linux network only when the task explicitly enables it",()=>{
  const off=linuxSandboxArgs("/work","true",false,{PATH:"/bin"},[]);
  const on=linuxSandboxArgs("/work","true",true,{PATH:"/bin"},[]);
  expect(off).toContain("--unshare-all");
  expect(off).not.toContain("--share-net");
  expect(on.indexOf("--share-net")).toBeGreaterThan(on.indexOf("--unshare-all"));
 });
 it.skipIf(process.platform!=="darwin")("runs python3 with read-only Command Line Tools access and still blocks writes and network",async()=>{
  const parent=realpathSync(await mkdtemp(join(tmpdir(),"pig-python-sandbox-"))); const root=await mkdtemp(join(parent,"workspace-"));
  try {
   const profile=seatbeltProfile(root,"/tmp/pig-temp",false);
   expect(profile).toContain("/Library/Developer/CommandLineTools");
   expect(profile).not.toContain("(allow network-outbound)");
   expect(profile).not.toMatch(/file-write\*.*\/Library\/Developer/);
   const result=await run(root,"python3 -c 'print(12345)'");
   expect(result.out).toContain("12345");
   expect(result.code).toBe(0);
   expect(result.out).not.toContain("libxcrun.dylib");
   expect((await run(root,`echo no > '${parent}/outside'`)).code).not.toBe(0);
   expect((await run(root,"curl --connect-timeout 1 http://127.0.0.1:9")).code).not.toBe(0);
  } finally {await rm(parent,{recursive:true,force:true})}
 },20000);
 it.skipIf(process.platform!=="darwin")("allows workspace tools but blocks outside reads, writes and networking",async()=>{
  const parent=realpathSync(await mkdtemp(join(tmpdir(),"pig-native-test-"))); const root=await mkdtemp(join(parent,"workspace-"));
  try {
   await writeFile(join(parent,"secret"),"PRIVATE");
   expect((await run(root,"echo hello > result.txt; node -e 'console.log(1+1)'"))).toMatchObject({code:0});
   expect(await readFile(join(root,"result.txt"),"utf8")).toBe("hello\n");
   expect((await run(root,`cat '${parent}/secret'`)).code).not.toBe(0);
   expect((await run(root,`echo forbidden > '${parent}/outside'`)).code).not.toBe(0);
   expect((await run(root,"curl --connect-timeout 1 http://127.0.0.1:8890")).code).not.toBe(0);
  } finally {await rm(parent,{recursive:true,force:true})}
 },15000);
});
