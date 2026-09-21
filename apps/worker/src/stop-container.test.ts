import { describe, expect, it, vi } from "vitest";
import { createContainerStopper } from "./stop-container.ts";

describe("container shutdown reconciliation", () => {
  it("retries after one failed stop instead of treating cancellation as confirmed", async () => {
    const docker = vi
      .fn()
      .mockRejectedValueOnce(Error("Docker 500: unavailable"))
      .mockResolvedValueOnce({});
    const shutdown = createContainerStopper(docker, () => "container-1");
    await expect(shutdown.stop()).rejects.toThrow("Docker 500");
    expect(shutdown.requested).toBe(true);
    expect(shutdown.confirmed).toBe(false);
    await shutdown.stop();
    expect(shutdown.confirmed).toBe(true);
    expect(docker.mock.calls).toEqual([
      ["POST", "/containers/container-1/stop?t=2"],
      ["POST", "/containers/container-1/stop?t=2"],
    ]);
    await shutdown.stop();
    expect(docker).toHaveBeenCalledTimes(2);
  });

  it("merges concurrent calls while Docker is responding", async () => {
    let finish!: (value: unknown) => void;
    const docker = vi.fn(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const shutdown = createContainerStopper(docker, () => "container-2");
    const first = shutdown.stop();
    const second = shutdown.stop();
    expect(first).toBe(second);
    expect(docker).toHaveBeenCalledTimes(1);
    expect(shutdown.confirmed).toBe(false);
    finish({});
    await Promise.all([first, second]);
    expect(shutdown.confirmed).toBe(true);
  });

  it("force-deletes after two failed graceful stops", async () => {
    const docker = vi
      .fn()
      .mockRejectedValueOnce(Error("Docker 500: first"))
      .mockRejectedValueOnce(Error("Docker timeout"))
      .mockResolvedValueOnce({});
    const shutdown = createContainerStopper(docker, () => "container-3");
    await expect(shutdown.stop()).rejects.toThrow("first");
    await shutdown.stop();
    expect(docker.mock.calls.at(-1)).toEqual([
      "DELETE",
      "/containers/container-3?force=1&v=1",
    ]);
    expect(shutdown.confirmed).toBe(true);
  });

  it("reports failed forced deletion and remains retryable", async () => {
    const docker = vi
      .fn()
      .mockRejectedValueOnce(Error("Docker 500: first"))
      .mockRejectedValueOnce(Error("Docker 500: second"))
      .mockRejectedValueOnce(Error("Docker 500: delete"))
      .mockResolvedValueOnce({});
    const shutdown = createContainerStopper(docker, () => "container-4");
    await expect(shutdown.stop()).rejects.toThrow("first");
    await expect(shutdown.stop()).rejects.toBeInstanceOf(AggregateError);
    expect(shutdown.confirmed).toBe(false);
    await shutdown.stop();
    expect(shutdown.confirmed).toBe(true);
  });

  it("keeps cancellation requested during container creation and stops once its ID is known", async () => {
    let id = "";
    const docker = vi.fn().mockResolvedValue({});
    const shutdown = createContainerStopper(docker, () => id);
    await shutdown.stop();
    expect(shutdown.requested).toBe(true);
    expect(shutdown.confirmed).toBe(false);
    expect(docker).not.toHaveBeenCalled();
    id = "container-5";
    await shutdown.stop();
    expect(shutdown.confirmed).toBe(true);
  });

  it("accepts Docker's missing-container response as confirmed cleanup", async () => {
    const docker = vi
      .fn()
      .mockRejectedValue(Error("Docker 404: No such container"));
    const shutdown = createContainerStopper(docker, () => "gone");
    await shutdown.stop();
    expect(shutdown.confirmed).toBe(true);
  });
});
