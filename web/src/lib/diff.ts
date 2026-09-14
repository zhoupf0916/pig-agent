export type DiffLine = {
  type: "eq" | "add" | "del";
  text: string;
};

export function lineDiff(before: string, after: string, maxLines = 400): DiffLine[] {
  const a = before.replace(/\r\n/g, "\n").split("\n");
  const b = after.replace(/\r\n/g, "\n").split("\n");
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m && out.length < maxLines) {
    if (a[i] === b[j]) {
      out.push({ type: "eq", text: a[i]! });
      i += 1;
      j += 1;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      out.push({ type: "del", text: a[i]! });
      i += 1;
    } else {
      out.push({ type: "add", text: b[j]! });
      j += 1;
    }
  }
  while (i < n && out.length < maxLines) {
    out.push({ type: "del", text: a[i]! });
    i += 1;
  }
  while (j < m && out.length < maxLines) {
    out.push({ type: "add", text: b[j]! });
    j += 1;
  }
  return out;
}
