export type DockerStopRequest = (
  method: string,
  path: string,
) => Promise<unknown>;

/**
 * Requested cancellation is distinct from confirmed resource shutdown. A failed
 * Docker request remains retryable; two failed graceful stops escalate to a
 * forced deletion. Calls in flight share one request and one result.
 */
export function createContainerStopper(
  docker: DockerStopRequest,
  getContainerId: () => string,
) {
  let requested = false;
  let confirmedId = "";
  let attemptedId = "";
  let failures = 0;
  let inFlight: Promise<void> | undefined;

  function missing(error: unknown) {
    return error instanceof Error && /^Docker 404(?:\b|:)/.test(error.message);
  }

  async function attempt(id: string): Promise<void> {
    if (attemptedId !== id) {
      attemptedId = id;
      failures = 0;
    }
    try {
      await docker("POST", `/containers/${id}/stop?t=2`);
      confirmedId = id;
      return;
    } catch (error) {
      if (missing(error)) {
        confirmedId = id;
        return;
      }
      failures++;
      if (failures < 2) throw error;
      try {
        await docker("DELETE", `/containers/${id}?force=1&v=1`);
        confirmedId = id;
      } catch (deleteError) {
        if (missing(deleteError)) {
          confirmedId = id;
          return;
        }
        throw new AggregateError(
          [error, deleteError],
          "Container shutdown unconfirmed: graceful stop and forced deletion failed",
        );
      }
    }
  }

  return {
    get requested() {
      return requested;
    },
    get confirmed() {
      const id = getContainerId();
      return Boolean(id && confirmedId === id);
    },
    stop(): Promise<void> {
      requested = true;
      if (inFlight) return inFlight;
      const id = getContainerId();
      // Cancellation may race with container creation. Keep it requested so the
      // caller can prevent startup, and permit another stop after creation.
      if (!id || id === confirmedId) return Promise.resolve();
      inFlight = attempt(id).finally(() => {
        inFlight = undefined;
      });
      return inFlight;
    },
  };
}
