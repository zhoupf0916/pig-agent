import { describe, expect, it } from "vitest";
import { Counter, Gauge, Histogram, Registry } from "./metrics.ts";

describe("metrics registry", () => {
  it("renders Prometheus text with escaped labels", async () => {
    const registry = new Registry();
    const c = registry.register(new Counter("t_requests_total", "Requests"));
    const g = registry.register(new Gauge("t_up", "Up"));
    c.inc({ route: '/a"b', status: "2xx" });
    c.inc({ status: "2xx", route: '/a"b' }, 2);
    registry.onCollect(() => g.set(1));
    registry.onCollect(() => { throw new Error("collector down"); });
    const text = await registry.render();
    expect(text).toContain("# TYPE t_requests_total counter");
    expect(text).toContain('t_requests_total{route="/a\\"b",status="2xx"} 3');
    expect(text).toContain("t_up 1");
    expect(c.sum({ status: "2xx" })).toBe(3);
  });
  it("caps label cardinality", () => {
    const c = new Counter("t", "t", 2);
    for (const route of ["a", "b", "c"]) c.inc({ route });
    expect(c.lines()).toHaveLength(2);
  });
  it("histogram buckets are cumulative and quantiles interpolate", () => {
    const h = new Histogram("t_seconds", "t", [0.1, 1, 10]);
    for (const v of [0.05, 0.05, 0.5, 5]) h.observe(v, { route: "/x" });
    const lines = h.lines();
    expect(lines).toContain('t_seconds_bucket{route="/x",le="0.1"} 2');
    expect(lines).toContain('t_seconds_bucket{route="/x",le="1"} 3');
    expect(lines).toContain('t_seconds_bucket{route="/x",le="+Inf"} 4');
    expect(lines).toContain('t_seconds_count{route="/x"} 4');
    expect(h.quantile(0.5)).toBeCloseTo(0.1);
    expect(h.quantile(0.75)).toBeCloseTo(1);
    expect(h.quantile(0.5, { route: "/none" })).toBeUndefined();
  });
});
