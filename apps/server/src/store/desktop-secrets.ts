/** Installed only by the desktop utility process; secrets never travel to the renderer. */
export type DesktopSecrets = { llmApiKey: string; cloudToken: string; codexApiKey?: string };
export interface SecretStore {
  read(): Promise<DesktopSecrets>;
  write(value: DesktopSecrets): Promise<void>;
}
export let desktopSecrets: SecretStore | undefined;
export function setDesktopSecrets(store: SecretStore | undefined): void {
  desktopSecrets = store;
}
