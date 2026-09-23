/** Installed only by the desktop utility process; secrets never travel to the renderer. */
export type DesktopSecrets = { llmApiKey: string; cloudToken: string; codexApiKey?: string; mcpSecrets?: Record<string, string> };
export interface SecretStore {
  read(): Promise<DesktopSecrets>;
  write(value: DesktopSecrets): Promise<void>;
}
export let desktopSecrets: SecretStore | undefined;
export function setDesktopSecrets(store: SecretStore | undefined): void {
  desktopSecrets = store;
}

let queue: Promise<unknown> = Promise.resolve();

/** Read-modify-write so a settings save cannot drop MCP credentials, and the reverse. */
export function updateDesktopSecrets(change: (current: DesktopSecrets) => DesktopSecrets | Promise<DesktopSecrets>): Promise<void> {
  const store = desktopSecrets;
  if (!store) return Promise.reject(new Error("当前环境不能安全保存凭据"));
  const task = queue.then(async () => {
    const current = await store.read();
    await store.write(await change(current));
  });
  queue = task.catch(() => undefined);
  return task.then(() => undefined);
}
