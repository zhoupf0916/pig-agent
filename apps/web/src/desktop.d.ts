interface Window {
  pigDesktop?: {
    chooseWorkspace(): Promise<string | null>;
    info(): Promise<{ version: string; platform: string }>;
  };
}
