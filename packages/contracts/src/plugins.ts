import type { EcosystemExpert, EcosystemSkill } from "./ecosystem.ts";

/** Declarative instruction packs. Executable tools are configured separately through MCP. */
export type PluginManifest = {
  format: "pig-plugin-v1";
  id: string;
  name: string;
  version: string;
  description: string;
  skills: EcosystemSkill[];
  experts: EcosystemExpert[];
};

export type InstalledPlugin = {
  manifest: PluginManifest;
  enabled: boolean;
  installedAt: string;
};
