import { readdir, readFile } from "node:fs/promises";
/** Linux /proc sampling. Aggregate Runner cgroups remain the hard containment limit. */
export async function processUsage(rootPid: number) {
  const rows = await Promise.all(
    (await readdir("/proc"))
      .filter((p) => /^\d+$/.test(p))
      .map(async (p) => {
        try {
          const stat = await readFile(`/proc/${p}/stat`, "utf8");
          const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
          const status = await readFile(`/proc/${p}/status`, "utf8");
          return {
            pid: Number(p),
            parent: Number(fields[1]),
            cpuTicks: Number(fields[11]) + Number(fields[12]),
            rss: Number(status.match(/^VmRSS:\s+(\d+)/m)?.[1] || 0) * 1024,
          };
        } catch {
          return null;
        }
      }),
  );
  const pids = new Set([rootPid]);
  for (let previous = -1; previous !== pids.size; ) {
    previous = pids.size;
    for (const row of rows) if (row && pids.has(row.parent)) pids.add(row.pid);
  }
  return {
    pids: pids.size,
    cpuSeconds: rows.reduce(
      (sum, row) => sum + (row && pids.has(row.pid) ? row.cpuTicks / 100 : 0),
      0,
    ),
    memoryBytes: rows.reduce(
      (sum, row) => sum + (row && pids.has(row.pid) ? row.rss : 0),
      0,
    ),
  };
}
