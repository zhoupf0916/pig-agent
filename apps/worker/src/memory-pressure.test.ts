import { describe, expect, it } from "vitest";
import { claimBlockedReason, memoryPolicyFromEnv, readMemorySample } from "./memory-pressure.ts";

const MiB = 1048576;
const files = (map: Record<string, string>) => (path: string) => map[path];
const meminfo = (availableKb: number) => `MemTotal:  3807232 kB\nMemFree: 100 kB\nMemAvailable:   ${availableKb} kB\n`;

describe("worker memory backpressure", () => {
  it("reads cgroup v2 working set (excluding inactive file cache) and host MemAvailable", () => {
    const sample = readMemorySample(files({
      "/sys/fs/cgroup/memory.current": String(400 * MiB),
      "/sys/fs/cgroup/memory.max": String(512 * MiB),
      "/sys/fs/cgroup/memory.stat": `anon 1\ninactive_file ${100 * MiB}\nactive_file 5\n`,
      "/proc/meminfo": meminfo(1_000_000),
    }));
    expect(sample).toEqual({ cgroupWorkingSet: 300 * MiB, cgroupLimit: 512 * MiB, hostAvailable: 1_000_000 * 1024 });
  });
  it("treats cgroup v2 'max' and v1 near-2^63 limits as unlimited", () => {
    expect(readMemorySample(files({ "/sys/fs/cgroup/memory.current": "10", "/sys/fs/cgroup/memory.max": "max\n" })).cgroupLimit).toBeUndefined();
    const v1 = readMemorySample(files({
      "/sys/fs/cgroup/memory/memory.usage_in_bytes": String(50 * MiB),
      "/sys/fs/cgroup/memory/memory.limit_in_bytes": "9223372036854771712",
      "/sys/fs/cgroup/memory/memory.stat": `total_inactive_file ${10 * MiB}\n`,
    }));
    expect(v1).toEqual({ cgroupWorkingSet: 40 * MiB, cgroupLimit: undefined });
  });
  it("blocks claims near the container limit or when the host is short of memory", () => {
    const policy = { maxCgroupRatio: 0.85, minHostAvailableBytes: 300 * MiB };
    expect(claimBlockedReason({ cgroupWorkingSet: 300 * MiB, cgroupLimit: 512 * MiB, hostAvailable: 900 * MiB }, policy)).toBeUndefined();
    expect(claimBlockedReason({ cgroupWorkingSet: 450 * MiB, cgroupLimit: 512 * MiB }, policy)).toMatch(/container memory 450MiB\/512MiB/);
    expect(claimBlockedReason({ hostAvailable: 200 * MiB }, policy)).toMatch(/host MemAvailable 200MiB < 300MiB/);
    expect(claimBlockedReason({}, policy)).toBeUndefined();
  });
  it("validates env configuration", () => {
    expect(memoryPolicyFromEnv({})).toEqual({ maxCgroupRatio: 0.85, minHostAvailableBytes: 300 * MiB });
    expect(memoryPolicyFromEnv({ WORKER_MAX_MEMORY_RATIO: "0.9", WORKER_MIN_HOST_AVAILABLE_MB: "400" }).minHostAvailableBytes).toBe(400 * MiB);
    expect(() => memoryPolicyFromEnv({ WORKER_MAX_MEMORY_RATIO: "2" })).toThrow();
    expect(() => memoryPolicyFromEnv({ WORKER_MIN_HOST_AVAILABLE_MB: "-1" })).toThrow();
  });
});
