import { randomBytes } from "node:crypto";

export function nowIso(): string {
  return new Date().toISOString();
}

export function newId(prefix = ""): string {
  const id = randomBytes(8).toString("hex");
  return prefix ? `${prefix}_${id}` : id;
}

export function truncate(text: string, max = 48): string {
  const trimmed = text.replace(/\s+/g, " ").trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1)}…`;
}

export function capText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const omitted = text.length - maxChars;
  return `${text.slice(0, maxChars)}\n\n…[truncated ${omitted} chars]`;
}

export async function atomicWriteJson(
  filePath: string,
  value: unknown,
): Promise<void> {
  const { writeFile, rename, mkdir } = await import("node:fs/promises");
  const { dirname } = await import("node:path");
  await mkdir(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
  await rename(tmp, filePath);
}

export function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}
