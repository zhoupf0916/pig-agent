export class PatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PatchError";
  }
}

export type Replacement = {
  old_string: string;
  new_string: string;
};

export function applyReplacements(original: string, replacements: Replacement[]): string {
  let next = original;
  if (replacements.length === 0) {
    throw new PatchError("At least one replacement is required");
  }
  for (const [i, item] of replacements.entries()) {
    if (!item.old_string) {
      throw new PatchError(`Replacement ${i + 1} is missing old_string`);
    }
    const matches = next.split(item.old_string).length - 1;
    if (matches === 0) {
      throw new PatchError(`Replacement ${i + 1}: old_string was not found`);
    }
    if (matches > 1) {
      throw new PatchError(
        `Replacement ${i + 1}: old_string matched ${matches} times; it must be unique`,
      );
    }
    next = next.replace(item.old_string, item.new_string);
  }
  return next;
}

type HunkLine = { kind: "context" | "add" | "del"; text: string };

type Hunk = { lines: HunkLine[] };

/**
 * Apply a unified diff (or a *** Begin Patch wrapper) to file text.
 * Each hunk's old block must match exactly once.
 */
export function applyUnifiedPatch(original: string, patch: string): string {
  const hunks = parseUnifiedHunks(patch);
  if (hunks.length === 0) {
    throw new PatchError("Patch contained no hunks");
  }
  let next = original;
  for (const [i, hunk] of hunks.entries()) {
    const oldBlock = hunk.lines
      .filter((l) => l.kind === "context" || l.kind === "del")
      .map((l) => l.text)
      .join("\n");
    const newBlock = hunk.lines
      .filter((l) => l.kind === "context" || l.kind === "add")
      .map((l) => l.text)
      .join("\n");
    if (!oldBlock) {
      throw new PatchError(`Hunk ${i + 1} has no old text to match`);
    }
    const matches = next.split(oldBlock).length - 1;
    if (matches === 0) {
      throw new PatchError(`Hunk ${i + 1} did not match the file`);
    }
    if (matches > 1) {
      throw new PatchError(`Hunk ${i + 1} matched ${matches} times; it must be unique`);
    }
    next = next.replace(oldBlock, newBlock);
  }
  return next;
}

export function parseUnifiedHunks(patch: string): Hunk[] {
  const lines = unwrapPatch(patch).replace(/\r\n/g, "\n").split("\n");
  const hunks: Hunk[] = [];
  let current: HunkLine[] | null = null;

  for (const line of lines) {
    if (line.startsWith("@@")) {
      if (current && current.length) hunks.push({ lines: current });
      current = [];
      continue;
    }
    if (
      line.startsWith("diff ") ||
      line.startsWith("index ") ||
      line.startsWith("--- ") ||
      line.startsWith("+++ ") ||
      line.startsWith("*** ")
    ) {
      continue;
    }
    if (current === null) {
      if (line.startsWith("+") || line.startsWith("-") || line.startsWith(" ")) {
        current = [];
      } else {
        continue;
      }
    }
    if (line === "\\ No newline at end of file") continue;
    if (line.startsWith("+")) {
      current.push({ kind: "add", text: line.slice(1) });
    } else if (line.startsWith("-")) {
      current.push({ kind: "del", text: line.slice(1) });
    } else if (line.startsWith(" ")) {
      current.push({ kind: "context", text: line.slice(1) });
    } else if (line === "") {
      // Unified diffs encode empty context as a single space; ignore bare separators.
      continue;
    }
  }
  if (current && current.length) hunks.push({ lines: current });
  return hunks;
}

function unwrapPatch(patch: string): string {
  const begin = patch.indexOf("*** Begin Patch");
  const end = patch.indexOf("*** End Patch");
  if (begin !== -1 && end !== -1 && end > begin) {
    return patch.slice(begin + "*** Begin Patch".length, end);
  }
  return patch;
}
