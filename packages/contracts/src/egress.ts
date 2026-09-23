/** Pure egress address checks. Callers must pin DNS to these results instead of fetching again. */

function parseGroups(raw: string): number[] | null {
  const halves = raw.split("::");
  if (halves.length > 2) return null;
  const side = (value: string) => {
    if (!value) return [] as number[];
    return value.split(":").map((part) => {
      if (!/^[0-9a-f]{1,4}$/i.test(part)) return Number.NaN;
      return Number.parseInt(part, 16);
    });
  };
  const left = side(halves[0] ?? "");
  const right = halves.length === 2 ? side(halves[1] ?? "") : [];
  if ([...left, ...right].some((part) => Number.isNaN(part))) return null;
  if (halves.length === 1) return left.length === 8 ? left : null;
  const missing = 8 - left.length - right.length;
  if (missing < 0) return null;
  return [...left, ...Array.from({ length: missing }, () => 0), ...right];
}

export function expandIp(input: string): { version: 4; v4: string } | { version: 6; groups: number[] } | null {
  const host = input.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) {
    const parts = host.split(".").map((part) => Number(part));
    if (parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
    return { version: 4, v4: parts.join(".") };
  }
  const dotted = host.match(/^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/);
  const normalized = dotted
    ? `${dotted[1]}${((Number(dotted[2]!.split(".")[0]) << 8) | Number(dotted[2]!.split(".")[1])).toString(16)}:${((Number(dotted[2]!.split(".")[2]) << 8) | Number(dotted[2]!.split(".")[3])).toString(16)}`
    : host;
  const groups = parseGroups(normalized);
  return groups ? { version: 6, groups } : null;
}

export function isPrivateIPv4Address(ip: string): boolean {
  const parts = ip.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const n = ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0;
  const ranges: Array<[number, number]> = [
    [0x00000000, 0xff000000],
    [0x0a000000, 0xff000000],
    [0x7f000000, 0xff000000],
    [0xa9fe0000, 0xffff0000],
    [0xac100000, 0xfff00000],
    [0xc0a80000, 0xffff0000],
    [0x64400000, 0xffc00000],
    [0xc0000000, 0xffffff00],
    [0xe0000000, 0xf0000000],
    [0xf0000000, 0xf0000000],
  ];
  return ranges.some(([base, mask]) => ((n & mask) >>> 0) === base);
}

function ipv4FromGroups(high: number, low: number): string {
  const n = ((high << 16) | low) >>> 0;
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
}

/** True for loopback, private, link-local, multicast, and IPv4-mapped forms of those ranges. */
export function isBlockedEgressAddress(input: string): boolean {
  const parsed = expandIp(input);
  if (!parsed) return true;
  if (parsed.version === 4) return isPrivateIPv4Address(parsed.v4);
  const groups = parsed.groups;
  if (groups[0] === 0 && groups[1] === 0 && groups[2] === 0 && groups[3] === 0 && groups[4] === 0 && groups[5] === 0xffff) {
    return isPrivateIPv4Address(ipv4FromGroups(groups[6]!, groups[7]!));
  }
  if (groups.every((group) => group === 0)) return true;
  if (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1) return true;
  if ((groups[0]! & 0xffc0) === 0xfe80) return true;
  if ((groups[0]! & 0xfe00) === 0xfc00) return true;
  if ((groups[0]! & 0xff00) === 0xff00) return true;
  if (groups[0] === 0x2002) return isPrivateIPv4Address(ipv4FromGroups(groups[1]!, groups[2]!));
  if (groups[0] === 0x64 && groups[1] === 0xff9b && (groups[2] === 0 || groups[2] === 1)) return true;
  return false;
}

/** Cloud metadata ranges stay blocked even when an admin allowlist names one fixture URL. */
export function isMetadataAddress(input: string): boolean {
  const parsed = expandIp(input);
  if (!parsed) return true;
  if (parsed.version === 4) {
    const [first, second] = parsed.v4.split(".").map((part) => Number(part));
    return first === 169 && second === 254;
  }
  const groups = parsed.groups;
  if (groups[0] === 0 && groups[1] === 0 && groups[2] === 0 && groups[3] === 0 && groups[4] === 0 && groups[5] === 0xffff) {
    return isMetadataAddress(ipv4FromGroups(groups[6]!, groups[7]!));
  }
  if (groups[0] === 0x64 && groups[1] === 0xff9b && groups[2] === 0 && groups[3] === 0 && groups[4] === 0 && groups[5] === 0) {
    return isMetadataAddress(ipv4FromGroups(groups[6]!, groups[7]!));
  }
  return false;
}

export function isLoopbackAddress(input: string): boolean {
  const parsed = expandIp(input);
  if (!parsed) return false;
  if (parsed.version === 4) return parsed.v4.startsWith("127.");
  const groups = parsed.groups;
  if (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1) return true;
  if (groups[0] === 0 && groups[1] === 0 && groups[2] === 0 && groups[3] === 0 && groups[4] === 0 && groups[5] === 0xffff) {
    return ipv4FromGroups(groups[6]!, groups[7]!).startsWith("127.");
  }
  return false;
}
