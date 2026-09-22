/** Latest login/logout intent wins, while all credential writes remain serialized. */
export function createRemoteAuthGate() {
  let generation = 0;
  let tail: Promise<unknown> = Promise.resolve();
  return function run<T>(
    action: (current: () => boolean) => Promise<T>,
  ): Promise<T> {
    const revision = ++generation;
    const result = tail.then(() => action(() => revision === generation));
    tail = result.catch(() => undefined);
    return result;
  };
}
