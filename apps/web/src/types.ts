export type * from "@pig-agent/contracts";
export type {
  PublicSettings as Settings,
  ProjectDetail as Project,
} from "@pig-agent/contracts";

export type LiveTool = {
  id: string;
  name: string;
  arguments: unknown;
  output?: string;
  ok?: boolean;
  done: boolean;
  startedAt?: string;
  durationMs?: number;
};
