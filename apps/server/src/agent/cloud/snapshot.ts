import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import type { CloudInstallHints, CloudWorkspaceHandoff } from "./contract.ts";
import { hasInstallHints } from "./environment-json.ts";

export type { CloudWorkspaceHandoff };

const TAR_BLOCK = 512;
const USTAR_NAME_MAX = 100;

/** Directory names never copied into a remote snapshot or local-stub isolate. */
export const CLOUD_HANDOFF_SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "data",
  "dist",
  ".vite",
  "coverage",
  ".ssh",
]);

const KEY_BASENAMES = new Set(["id_rsa", "id_dsa", "id_ecdsa", "id_ed25519"]);
const KEY_EXTENSIONS = new Set([".pem", ".key", ".p12", ".pfx", ".keystore"]);

export const MAX_SNAPSHOT_FILES = 400;
export const MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024;
export const MAX_SNAPSHOT_FILE_BYTES = 512 * 1024;

export type CloudWorkspaceSnapshot = {
  encoding: "tar.gz";
  /** gzip(ustar) of sandbox-safe files. Never includes .env* / keys / node_modules / .git. */
  data: string;
  files: string[];
  skipped: string[];
  byteSize: number;
  truncated?: boolean;
};

/**
 * Skip rules for workspace handoff (remote snapshot + local-stub copy).
 * - `.env*` (any env file)
 * - key material (`id_rsa`, `*.pem` / `*.key` / …)
 * - `node_modules`, `.git`, build/cache dirs
 */
export function shouldSkipCloudHandoffName(name: string): boolean {
  if (!name) return true;
  if (CLOUD_HANDOFF_SKIP_DIRS.has(name)) return true;
  if (name === ".env" || name.startsWith(".env")) return true;
  if (KEY_BASENAMES.has(name)) return true;
  const dot = name.lastIndexOf(".");
  if (dot >= 0 && KEY_EXTENSIONS.has(name.slice(dot).toLowerCase())) return true;
  return false;
}

export { resolveCloudRepoHint } from "./env-json.ts";

export function collectWorkspaceHandoff(options: {
  workspaceRoot: string;
  repoUrl?: string;
  ref?: string;
  installHints?: CloudInstallHints;
}): CloudWorkspaceHandoff {
  const handoff: CloudWorkspaceHandoff = {};
  const repoUrl = options.repoUrl?.trim();
  const ref = options.ref?.trim();
  if (repoUrl) handoff.repoUrl = repoUrl;
  if (ref) handoff.ref = ref;
  if (hasInstallHints(options.installHints)) handoff.installHints = options.installHints;
  if (existsSync(options.workspaceRoot)) {
    handoff.snapshot = packWorkspaceSnapshot(options.workspaceRoot);
  }
  return handoff;
}

export function packWorkspaceSnapshot(root: string, excludedPaths: readonly string[] = [], mode: "local-handoff" | "cloud-result" = "local-handoff"): CloudWorkspaceSnapshot {
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw new Error("工作区路径不是可读目录");
  }
  const collected: Array<{ path: string; data: Buffer }> = [];
  const skipped: string[] = [];
  let truncated = false;
  let uncompressed = 0;

  const walk = (abs: string, rel: string): void => {
    let entries;
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const childRel = rel ? `${rel}/${ent.name}` : ent.name;
      if (excludedPaths.includes(childRel)) continue;
      if (shouldSkipCloudHandoffName(ent.name) && !(mode === "cloud-result" && ent.name === "data")) {
        skipped.push(childRel);
        continue;
      }
      const childAbs = join(abs, ent.name);
      let st;
      try {
        st = lstatSync(childAbs);
      } catch {
        skipped.push(childRel);
        continue;
      }
      if (st.isSymbolicLink()) {
        skipped.push(childRel);
        continue;
      }
      if (st.isDirectory()) {
        walk(childAbs, childRel);
        continue;
      }
      if (!st.isFile()) {
        skipped.push(childRel);
        continue;
      }
      if (st.size > MAX_SNAPSHOT_FILE_BYTES) {
        truncated = true;
        skipped.push(childRel);
        continue;
      }
      if (Buffer.byteLength(childRel, "utf8") > USTAR_NAME_MAX) {
        truncated = true;
        skipped.push(childRel);
        continue;
      }
      if (collected.length >= MAX_SNAPSHOT_FILES || uncompressed + st.size > MAX_SNAPSHOT_BYTES) {
        skipped.push(childRel);
        truncated = true;
        continue;
      }
      let data: Buffer;
      try {
        data = readFileSync(childAbs);
      } catch {
        skipped.push(childRel);
        continue;
      }
      collected.push({ path: childRel.replace(/\\/g, "/"), data });
      uncompressed += data.length;
    }
  };

  walk(root, "");
  const tar = packUstar(collected);
  const gz = gzipSync(tar);
  return {
    encoding: "tar.gz",
    data: gz.toString("base64"),
    files: collected.map((f) => f.path),
    skipped,
    byteSize: gz.length,
    ...(truncated ? { truncated: true } : {}),
  };
}

/** Unpack a snapshot into destRoot. Path escapes and skip-rule names are refused. */
export function extractWorkspaceSnapshot(snapshot: CloudWorkspaceSnapshot, destRoot: string, mode: "local-handoff" | "cloud-result" = "local-handoff"): string[] {
  const tar = gunzipSync(Buffer.from(snapshot.data, "base64"), { maxOutputLength: MAX_SNAPSHOT_BYTES + MAX_SNAPSHOT_FILES * 1024 + 1024 });
  const files: string[] = [];
  let offset = 0;
  while (offset + TAR_BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + TAR_BLOCK);
    offset += TAR_BLOCK;
    if (header.every((b) => b === 0)) break;
    const name = readTarString(header, 0, 100);
    const rawSize = readTarString(header, 124, 12);
    if (!/^[0-7]+$/.test(rawSize)) throw new Error("Invalid snapshot size field");
    const size = parseInt(rawSize, 8);
    const typeflag = String.fromCharCode(header[156] ?? 0);
    const data = tar.subarray(offset, offset + size);
    offset += size + padding(size);
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_SNAPSHOT_FILE_BYTES || data.length !== size) throw new Error("Invalid snapshot file size");
    if (files.length >= MAX_SNAPSHOT_FILES) throw new Error("Too many snapshot files");
    if (!name) continue;
    if (name.includes("..") || name.startsWith("/") || name.includes("\\")) {
      throw new Error("Snapshot path escape refused");
    }
    if (name.split("/").some(part => shouldSkipCloudHandoffName(part) && !(mode === "cloud-result" && part === "data"))) {
      throw new Error(`Snapshot contained a skipped path: ${name}`);
    }
    if (typeflag !== "0" && typeflag !== "\0") continue;
    const dest = join(destRoot, name);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, data);
    files.push(name);
  }
  return files;
}

function packUstar(files: Array<{ path: string; data: Buffer }>): Buffer {
  const chunks: Buffer[] = [];
  for (const file of files) {
    chunks.push(ustarHeader(file.path, file.data.length));
    chunks.push(file.data);
    const pad = padding(file.data.length);
    if (pad) chunks.push(Buffer.alloc(pad));
  }
  chunks.push(Buffer.alloc(TAR_BLOCK * 2));
  return Buffer.concat(chunks);
}

function ustarHeader(name: string, size: number): Buffer {
  const buf = Buffer.alloc(TAR_BLOCK);
  writeTarString(buf, 0, 100, name);
  writeTarString(buf, 100, 8, octal(0o644, 7));
  writeTarString(buf, 108, 8, octal(0, 7));
  writeTarString(buf, 116, 8, octal(0, 7));
  writeTarString(buf, 124, 12, octal(size, 11));
  writeTarString(buf, 136, 12, octal(Math.floor(Date.now() / 1000), 11));
  buf.fill(0x20, 148, 156);
  buf[156] = 0x30; // regular file
  writeTarString(buf, 257, 6, "ustar");
  writeTarString(buf, 263, 2, "00");
  let sum = 0;
  for (let i = 0; i < TAR_BLOCK; i += 1) sum += buf[i] ?? 0;
  writeTarString(buf, 148, 8, `${octal(sum, 6)}\0 `);
  return buf;
}

function writeTarString(buf: Buffer, offset: number, length: number, value: string): void {
  buf.write(value, offset, length, "utf8");
}

function readTarString(buf: Buffer, offset: number, length: number): string {
  const slice = buf.subarray(offset, offset + length);
  const end = slice.indexOf(0);
  return slice.subarray(0, end === -1 ? length : end).toString("utf8").trim();
}

function octal(n: number, digits: number): string {
  return n.toString(8).padStart(digits, "0");
}

function padding(size: number): number {
  return (TAR_BLOCK - (size % TAR_BLOCK)) % TAR_BLOCK;
}
