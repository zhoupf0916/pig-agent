import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import type { AssetPreview, AssetPreviewKind, Project, ProjectAsset } from "../types.ts";
import { assetDiskPath } from "./projects.ts";

export const MAX_ASSET_PREVIEW_BYTES = 1_500_000;

const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico"]);
const MARKDOWN_EXT = new Set(["md", "mdx"]);
const JSON_EXT = new Set(["json"]);
const TEXT_EXT = new Set([
  "ts",
  "tsx",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "txt",
  "py",
  "go",
  "rs",
  "java",
  "kt",
  "rb",
  "php",
  "css",
  "scss",
  "html",
  "vue",
  "svelte",
  "sh",
  "bash",
  "zsh",
  "yml",
  "yaml",
  "toml",
  "sql",
  "env",
  "csv",
  "log",
  "xml",
]);

function extOf(filename: string): string {
  const base = filename.split("/").pop() ?? filename;
  const i = base.lastIndexOf(".");
  return i === -1 ? "" : base.slice(i + 1).toLowerCase();
}

export function findProjectAsset(project: Project, assetId: string): ProjectAsset | undefined {
  return project.assets.find((a) => a.id === assetId);
}

export function classifyAssetPreview(filename: string, mimeType = ""): AssetPreviewKind {
  const mime = mimeType.toLowerCase();
  const ext = extOf(filename);
  if (mime.startsWith("image/") || IMAGE_EXT.has(ext)) return "image";
  if (mime.includes("markdown") || MARKDOWN_EXT.has(ext)) return "markdown";
  if (mime.includes("json") || JSON_EXT.has(ext)) return "json";
  if (mime.startsWith("text/") || TEXT_EXT.has(ext)) return "text";
  return "binary";
}

export function contentDisposition(filename: string, kind: "attachment" | "inline"): string {
  const ascii = filename.replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "_") || "asset";
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export async function readAssetBytes(
  projectId: string,
  asset: ProjectAsset,
): Promise<Buffer | null> {
  const disk = assetDiskPath(projectId, asset);
  if (!existsSync(disk)) return null;
  return readFile(disk);
}

export async function buildAssetPreview(
  projectId: string,
  asset: ProjectAsset,
): Promise<AssetPreview> {
  const disk = assetDiskPath(projectId, asset);
  if (!existsSync(disk)) {
    throw new Error("Asset file is missing on disk");
  }
  const st = await stat(disk);
  if (st.size > MAX_ASSET_PREVIEW_BYTES) {
    throw new Error("File too large to preview");
  }
  const buf = await readFile(disk);
  const declared = classifyAssetPreview(asset.filename, asset.mimeType);
  const nul = buf.includes(0);
  let kind: AssetPreviewKind = declared;
  if (nul && kind !== "image") kind = "binary";
  if (kind === "binary" && !nul && buf.length > 0) {
    const sample = buf.subarray(0, Math.min(buf.length, 800));
    if (sample.every((b) => b === 9 || b === 10 || b === 13 || (b >= 32 && b !== 127))) {
      kind = "text";
    }
  }

  if (kind === "image") {
    return {
      asset,
      kind,
      content: "",
      contentBase64: buf.toString("base64"),
      binary: false,
      size: st.size,
    };
  }
  if (kind === "binary") {
    return { asset, kind, content: "", binary: true, size: st.size };
  }

  let content = buf.toString("utf8");
  if (kind === "json") {
    try {
      content = `${JSON.stringify(JSON.parse(content), null, 2)}\n`;
    } catch {
      // keep raw text
    }
  }
  return { asset, kind, content, binary: false, size: st.size };
}
