import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, realpathSync, mkdtempSync, openSync, closeSync, writeFileSync, rmSync, readdirSync, readFileSync } from "node:fs";
import type { Readable } from "node:stream";
import { tmpdir, homedir } from "node:os";
import { join, parse } from "node:path";
import { normalizeWorkspaceRoot } from "./sandbox.ts";

/** Deliberately allowlisted: subprocesses never inherit provider, worker or session credentials. */
export function toolEnvironment(root: string): NodeJS.ProcessEnv {
  return { PATH: process.platform === "darwin" ? "/opt/homebrew/opt/node@24/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" : "/usr/local/bin:/usr/bin:/bin", HOME: root, PWD: root, PIG_AGENT_WORKSPACE: root, LANG: "en_US.UTF-8", TMPDIR: "/tmp" };
}
const quote = (value: string) => JSON.stringify(value);
export function seatbeltProfile(root: string, temporary: string, network = false, trustedReadPaths: string[] = []) {
  return `(version 1)
(deny default)
(allow process-exec process-fork)
(allow signal (target self))
(allow sysctl-read)
(allow mach-lookup (global-name "com.apple.system.opendirectoryd.libinfo") (global-name "com.apple.system.logger"))
(allow file-read* (literal "/"))
(allow file-read-metadata)
(allow file-read* ${["/System", "/usr", "/bin", "/sbin", "/Library/Apple", "/Library/Developer/CommandLineTools", "/opt/homebrew", "/private/etc/ssl", "/private/etc/localtime", "/dev/null", "/dev/urandom", "/dev/random", root, temporary, ...trustedReadPaths].map(p => `(subpath ${quote(p)})`).join(" ")})
(allow file-write* (subpath ${quote(root)}) (subpath ${quote(temporary)}) (literal "/dev/null"))
${network ? "(allow network-outbound)\n(allow system-socket)" : ""}
`;
}
/** Classic BPF seccomp filter: reject alternate ABIs and dangerous namespace/kernel operations. */
export function seccompFilter(arch: string) {
  const arm = arch === "arm64";
  if (!arm && arch !== "x64") throw new Error(`Unsupported sandbox architecture: ${arch}`);
  const audit = arm ? 0xc00000b7 : 0xc000003e;
  const blocked = arm ? [39,40,41,97,104,105,106,117,142,219,224,225,241,268,272,273,280,282,294] : [101,155,165,166,167,169,172,173,175,176,246,248,249,250,272,298,300,303,304,308,312,313,321,323];
  const ops: [number, number, number, number][] = [[0x20,0,0,4],[0x15,1,0,audit],[0x06,0,0,0x80000000],[0x20,0,0,0]];
  // x32 syscall numbers must not bypass the x86_64 deny list.
  if (!arm) ops.push([0x45,0,1,0x40000000],[0x06,0,0,0x80000000]);
  // clone() can otherwise create a nested user namespace and regain capabilities.
  // Keep ordinary fork/thread flags, but reject every namespace-creation flag.
  ops.push([0x15,0,3,arm ? 220 : 56],[0x20,0,0,16],[0x45,0,1,0x7e020080],[0x06,0,0,0x00050001],[0x20,0,0,0]);
  // io_uring and the newer mount API are unnecessary for workstation tools.
  for (const syscall of [...blocked,425,426,427,428,429,430,431,432,433,435,442,443]) ops.push([0x15,0,1,syscall],[0x06,0,0,0x00050000 | (syscall === 435 ? 38 : 1)]);
  ops.push([0x06,0,0,0x7fff0000]);
  const buffer = Buffer.alloc(ops.length * 8);
  ops.forEach(([code,jt,jf,k],i) => { buffer.writeUInt16LE(code,i*8); buffer[i*8+2]=jt; buffer[i*8+3]=jf; buffer.writeUInt32LE(k,i*8+4); });
  return buffer;
}
export function assertSafeNativeWorkspace(root: string) {
  const protectedRoots = [parse(root).root, homedir(), tmpdir(), "/tmp", "/private/tmp", "/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc", "/private", "/proc", "/sys", "/dev", "/var", "/private/var", "/Users", "/home", "/root", "/System", "/Library", "/opt", "/opt/homebrew"];
  if (protectedRoots.some(path => { try { return realpathSync(path) === root; } catch { return path === root; } })) throw new Error("请选择具体的项目目录；不能将系统根目录、主目录或共享临时目录作为沙箱工作区。");
}
export function linuxSandboxArgs(root: string, command: string, network: boolean, env: NodeJS.ProcessEnv, trustedReadPaths: string[]) {
  const args = ["--die-with-parent", "--new-session", "--unshare-all", "--cap-drop", "ALL", "--clearenv"];
  if (network) args.push("--share-net");
  for (const path of ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc/ssl/certs", "/etc/alternatives", "/etc/passwd", "/etc/group", "/etc/ld.so.cache"]) if (existsSync(path)) args.push("--ro-bind", path, path);
  args.push("--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--bind", root, root, "--chdir", root);
  for (const path of trustedReadPaths) args.push("--ro-bind", path, path);
  for (const [key, value] of Object.entries(env)) if (value) args.push("--setenv", key, value);
  args.push("--seccomp", "3", "/bin/sh", "-c", command);
  return args;
}
/** Signal a detached child's whole process group (seatbelt / plain spawn). */
function groupKiller(child: ChildProcess) {
  return (signal: NodeJS.Signals) => {
    try { if (child.pid) process.kill(-child.pid, signal); else child.kill(signal); }
    catch { try { child.kill(signal); } catch { /* already exited */ } }
  };
}
/** All descendants of a Linux process (breadth-first, from /proc). */
export function linuxDescendants(root: number): number[] {
  const parents = new Map<number, number[]>();
  try {
    for (const entry of readdirSync("/proc")) {
      if (!/^\d+$/.test(entry)) continue;
      try {
        const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
        const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
        parents.set(ppid, [...(parents.get(ppid) ?? []), Number(entry)]);
      } catch { /* raced exit */ }
    }
  } catch { /* no procfs */ }
  const out: number[] = [];
  for (let queue = [root]; queue.length; ) for (const pid of parents.get(queue.shift()!) ?? []) { out.push(pid); queue.push(pid); }
  return out;
}
/**
 * Stops a bubblewrap sandbox without orphaning it.
 * Signalling the outer bwrap first is unsafe: --new-session moves the command out of bwrap's process
 * group, and the sandbox's PID-namespace init ignores SIGTERM from outside its namespace, so once the
 * outer bwrap dies nothing can find the sandbox any more (the command keeps running and holds stdout).
 * Instead wait for --info-fd to report the init PID: SIGTERM goes to the commands inside, SIGKILL to the
 * init, which makes the kernel kill every process in the sandbox. A stop requested before setup
 * finishes is applied as soon as the PID is known.
 */
function bubblewrapKiller(child: ChildProcess) {
  let sandboxPid: number | undefined;
  let pending: NodeJS.Signals | undefined;
  let exited = false;
  let info = "";
  child.once("exit", () => { exited = true; });
  const stream = child.stdio[4] as Readable | null | undefined;
  stream?.setEncoding("utf8");
  stream?.on("error", () => {});
  const kill = (signal: NodeJS.Signals): void => {
    if (exited) return;
    if (sandboxPid === undefined) {
      pending = pending === "SIGKILL" ? pending : signal;
      // Setup normally reports within milliseconds; if bwrap stalls before reporting, fall back to its group.
      if (signal === "SIGKILL") setTimeout(() => { if (!exited && sandboxPid === undefined) groupKiller(child)("SIGKILL"); }, 3000).unref();
      return;
    }
    try {
      const inside = signal === "SIGKILL" ? [] : linuxDescendants(sandboxPid);
      // Nothing to stop gracefully (command not started yet, or SIGKILL): end the whole namespace.
      if (!inside.length) process.kill(sandboxPid, "SIGKILL");
      else for (const pid of inside) process.kill(pid, signal);
    } catch { /* already gone */ }
  };
  stream?.on("data", (chunk: string) => {
    info += chunk;
    const match = /"child-pid"\s*:\s*(\d+)/.exec(info);
    if (match && sandboxPid === undefined) {
      sandboxPid = Number(match[1]);
      if (pending) kill(pending);
    }
  });
  return kill;
}
export function nativeCommand(workspace: string, command: string, network = false, options: { trustedReadPaths?: string[]; stdin?: boolean; helper?: boolean } = {}) {
  const root = normalizeWorkspaceRoot(workspace);
  assertSafeNativeWorkspace(root);
  const temporary = realpathSync(mkdtempSync(join(tmpdir(), "pig-sandbox-")));
  const env = toolEnvironment(root);
  if (options.helper) { env.PIG_DESKTOP = "1"; env.PIG_FILE_HELPER = "1"; env.ELECTRON_RUN_AS_NODE = "1"; env.PIG_APP_ROOT = process.platform === "linux" ? "/tmp" : temporary; env.DATA_DIR = process.platform === "linux" ? "/tmp/pig-helper-data" : join(temporary,"data"); }
  let descriptor: number | undefined;
  let cleaned = false;
  const cleanup = () => { if (!cleaned) { cleaned=true; rmSync(temporary,{recursive:true,force:true}); } };
  try {
    if (process.platform === "darwin") {
      env.TMPDIR = temporary;
      const child = spawn("/usr/bin/sandbox-exec", ["-p",seatbeltProfile(root,temporary,network,options.trustedReadPaths),"/bin/sh","-c",command], { cwd:root, env, detached:true, stdio:[options.stdin ? "pipe" : "ignore","pipe","pipe"] });
      return {child,cleanup,backend:"seatbelt" as const,kill:groupKiller(child)};
    }
    if (process.platform !== "linux") throw new Error("当前系统尚未配置原生沙箱；请使用 macOS 或 Linux。不会自动切换到主机执行。");
    const filterPath = join(temporary,"seccomp.bpf");
    writeFileSync(filterPath,seccompFilter(process.arch)); descriptor=openSync(filterPath,"r");
    const args = linuxSandboxArgs(root, command, network, env, options.trustedReadPaths || []);
    // fd 4 = --info-fd: bwrap reports the sandbox's PID-namespace init once setup has finished.
    const child = spawn("bwrap",["--info-fd","4",...args],{cwd:root,env,detached:true,stdio:[options.stdin ? "pipe" : "ignore","pipe","pipe",descriptor,"pipe"]});
    closeSync(descriptor); descriptor=undefined;
    return {child,cleanup,backend:"bubblewrap" as const,kill:bubblewrapKiller(child)};
  } catch (error) { if(descriptor !== undefined) closeSync(descriptor); cleanup(); throw error; }
}
export async function nativeSandboxStatus() {
  try {
    const root=mkdtempSync(join(tmpdir(),"pig-probe-"));
    try {
      const execution=nativeCommand(root,"true");
      return await new Promise<{available:boolean; backend:string; error?:string}>(resolve=>{
        let error=""; const timer=setTimeout(()=>execution.child.kill("SIGKILL"),5000);
        execution.child.stderr!.on("data",chunk=>{error+=String(chunk)});
        execution.child.once("error",e=>{error=e.message});
        execution.child.once("close",code=>{clearTimeout(timer);execution.cleanup();resolve({available:code===0,backend:process.platform==="darwin"?"seatbelt":"bubblewrap",...(code===0?{}:{error:error.trim()||"原生沙箱自检失败"})})});
      });
    } finally {rmSync(root,{recursive:true,force:true});}
  } catch(error) {return {available:false,backend:process.platform,error:String(error)}}
}
