/**
 * Minimal Prometheus registry (text exposition format 0.0.4), no dependencies.
 * Counters/histograms are process-local; `collect` hooks compute gauges at scrape time (e.g. from the DB).
 */
type Labels = Record<string, string | number>;
const key = (labels: Labels) => JSON.stringify(Object.entries(labels).sort(([a], [b]) => a.localeCompare(b)));
const esc = (v: string) => v.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
const fmtLabels = (labels: Labels, extra: Labels = {}) => {
  const all = { ...labels, ...extra };
  const parts = Object.entries(all).map(([k, v]) => `${k}="${esc(String(v))}"`);
  return parts.length ? `{${parts.join(",")}}` : "";
};
const num = (v: number) => (Number.isFinite(v) ? String(v) : v > 0 ? "+Inf" : v < 0 ? "-Inf" : "NaN");

abstract class Metric {
  constructor(
    readonly name: string,
    readonly help: string,
    readonly type: "counter" | "gauge" | "histogram",
  ) {}
  abstract lines(): string[];
  render() {
    return [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} ${this.type}`, ...this.lines()].join("\n");
  }
}

export class Counter extends Metric {
  private values = new Map<string, { labels: Labels; value: number }>();
  constructor(name: string, help: string, private readonly maxSeries = 500) {
    super(name, help, "counter");
  }
  inc(labels: Labels = {}, by = 1) {
    const k = key(labels);
    const cur = this.values.get(k);
    if (cur) cur.value += by;
    else if (this.values.size < this.maxSeries) this.values.set(k, { labels, value: by });
  }
  get(labels: Labels = {}) {
    return this.values.get(key(labels))?.value ?? 0;
  }
  /** Sum of all series matching the given label subset. */
  sum(match: Labels = {}) {
    let total = 0;
    for (const { labels, value } of this.values.values()) if (Object.entries(match).every(([k, v]) => String(labels[k]) === String(v))) total += value;
    return total;
  }
  lines() {
    return [...this.values.values()].map(({ labels, value }) => `${this.name}${fmtLabels(labels)} ${num(value)}`);
  }
}

export class Gauge extends Metric {
  private values = new Map<string, { labels: Labels; value: number }>();
  constructor(name: string, help: string) {
    super(name, help, "gauge");
  }
  set(value: number, labels: Labels = {}) {
    this.values.set(key(labels), { labels, value });
  }
  reset() {
    this.values.clear();
  }
  get(labels: Labels = {}) {
    return this.values.get(key(labels))?.value;
  }
  lines() {
    return [...this.values.values()].map(({ labels, value }) => `${this.name}${fmtLabels(labels)} ${num(value)}`);
  }
}

export const DEFAULT_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300];

export class Histogram extends Metric {
  private series = new Map<string, { labels: Labels; counts: number[]; sum: number; count: number }>();
  constructor(name: string, help: string, readonly buckets = DEFAULT_BUCKETS, private readonly maxSeries = 300) {
    super(name, help, "histogram");
  }
  observe(value: number, labels: Labels = {}) {
    const k = key(labels);
    let s = this.series.get(k);
    if (!s) {
      if (this.series.size >= this.maxSeries) return;
      s = { labels, counts: this.buckets.map(() => 0), sum: 0, count: 0 };
      this.series.set(k, s);
    }
    this.buckets.forEach((b, i) => {
      if (value <= b) s!.counts[i]!++;
    });
    s.sum += value;
    s.count++;
  }
  /** Approximate quantile across all series matching `match` (linear within a bucket). */
  quantile(q: number, match: Labels = {}) {
    const counts = this.buckets.map(() => 0);
    let total = 0;
    for (const s of this.series.values()) {
      if (!Object.entries(match).every(([k, v]) => String(s.labels[k]) === String(v))) continue;
      s.counts.forEach((c, i) => (counts[i]! += c));
      total += s.count;
    }
    if (!total) return undefined;
    const rank = q * total;
    let prev = 0;
    for (let i = 0; i < this.buckets.length; i++) {
      if (counts[i]! >= rank) {
        const lo = i ? this.buckets[i - 1]! : 0;
        const inBucket = counts[i]! - prev;
        return lo + (this.buckets[i]! - lo) * (inBucket ? (rank - prev) / inBucket : 1);
      }
      prev = counts[i]!;
    }
    return this.buckets.at(-1);
  }
  lines() {
    const out: string[] = [];
    for (const s of this.series.values()) {
      this.buckets.forEach((b, i) => out.push(`${this.name}_bucket${fmtLabels(s.labels, { le: b })} ${s.counts[i]}`));
      out.push(`${this.name}_bucket${fmtLabels(s.labels, { le: "+Inf" })} ${s.count}`);
      out.push(`${this.name}_sum${fmtLabels(s.labels)} ${num(s.sum)}`);
      out.push(`${this.name}_count${fmtLabels(s.labels)} ${s.count}`);
    }
    return out;
  }
}

export class Registry {
  private metrics: Metric[] = [];
  private collectors: Array<() => Promise<void> | void> = [];
  register<T extends Metric>(m: T): T {
    this.metrics.push(m);
    return m;
  }
  onCollect(fn: () => Promise<void> | void) {
    this.collectors.push(fn);
  }
  async render() {
    await Promise.all(this.collectors.map(async (fn) => {
      try {
        await fn();
      } catch {
        /* a failing collector must not break the scrape */
      }
    }));
    return this.metrics.map((m) => m.render()).join("\n") + "\n";
  }
}
