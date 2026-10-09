import { readFileSync } from "node:fs";

/**
 * Claim backpressure: a worker stops taking new jobs while its own container (cgroup) is close to
 * its memory limit, or while the whole host is short of memory. Limits are ceilings, not
 * reservations; on a small single host (4 GB) several runners can otherwise push Postgres or the
 * control plane into the kernel OOM killer.
 */
export type MemorySample = {
  /** cgroup working set (usage minus inactive file cache), bytes */
  cgroupWorkingSet?: number;
  /** cgroup memory limit in bytes; undefined when unlimited */
  cgroupLimit?: number;
  /** MemAvailable from /proc/meminfo (host-wide inside a container without lxcfs), bytes */
  hostAvailable?: number;
};
export type MemoryPolicy = { maxCgroupRatio: number; minHostAvailableBytes: number };

type Read = (path: string) => string | undefined;
const defaultRead: Read = (path) => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
};
const number = (text: string | undefined) => {
  const value = Number(text?.trim());
  return Number.isFinite(value) && value >= 0 ? value : undefined;
};
const statField = (stat: string | undefined, key: string) =>
  number(stat?.match(new RegExp(`^${key} (\\d+)$`, "m"))?.[1]);
// cgroup v1 reports "unlimited" as a page-aligned value near 2^63.
const UNLIMITED = 2 ** 60;

export function readMemorySample(read: Read = defaultRead): MemorySample {
  const sample: MemorySample = {};
  const v2Current = number(read("/sys/fs/cgroup/memory.current"));
  if (v2Current !== undefined) {
    const max = read("/sys/fs/cgroup/memory.max")?.trim();
    const inactive = statField(read("/sys/fs/cgroup/memory.stat"), "inactive_file") ?? 0;
    sample.cgroupWorkingSet = Math.max(0, v2Current - inactive);
    sample.cgroupLimit = max && max !== "max" ? number(max) : undefined;
  } else {
    const usage = number(read("/sys/fs/cgroup/memory/memory.usage_in_bytes"));
    if (usage !== undefined) {
      const inactive =
        statField(read("/sys/fs/cgroup/memory/memory.stat"), "total_inactive_file") ?? 0;
      const limit = number(read("/sys/fs/cgroup/memory/memory.limit_in_bytes"));
      sample.cgroupWorkingSet = Math.max(0, usage - inactive);
      sample.cgroupLimit = limit !== undefined && limit < UNLIMITED ? limit : undefined;
    }
  }
  const kb = number(read("/proc/meminfo")?.match(/^MemAvailable:\s+(\d+) kB$/m)?.[1]);
  if (kb !== undefined) sample.hostAvailable = kb * 1024;
  return sample;
}

/** Reason to skip claiming now, or undefined when there is enough headroom. Unknown values never block. */
export function claimBlockedReason(sample: MemorySample, policy: MemoryPolicy): string | undefined {
  const mib = (bytes: number) => `${Math.round(bytes / 1048576)}MiB`;
  if (
    sample.cgroupLimit &&
    sample.cgroupWorkingSet !== undefined &&
    sample.cgroupWorkingSet / sample.cgroupLimit >= policy.maxCgroupRatio
  )
    return `container memory ${mib(sample.cgroupWorkingSet)}/${mib(sample.cgroupLimit)} ≥ ${Math.round(policy.maxCgroupRatio * 100)}%`;
  if (sample.hostAvailable !== undefined && sample.hostAvailable < policy.minHostAvailableBytes)
    return `host MemAvailable ${mib(sample.hostAvailable)} < ${mib(policy.minHostAvailableBytes)}`;
  return undefined;
}

export function memoryPolicyFromEnv(env: Record<string, string | undefined> = process.env): MemoryPolicy {
  const ratio = Number(env.WORKER_MAX_MEMORY_RATIO ?? "0.85");
  const minMb = Number(env.WORKER_MIN_HOST_AVAILABLE_MB ?? "300");
  if (!(ratio > 0 && ratio <= 1)) throw Error("WORKER_MAX_MEMORY_RATIO must be in (0, 1]");
  if (!(Number.isInteger(minMb) && minMb >= 0)) throw Error("WORKER_MIN_HOST_AVAILABLE_MB must be a non-negative integer");
  return { maxCgroupRatio: ratio, minHostAvailableBytes: minMb * 1048576 };
}
