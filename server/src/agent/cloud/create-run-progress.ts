import type { AgentEvent, PlanStep, Session } from "../../types.ts";
import { redactCloudErrorDetail } from "./errors.ts";

/** Host-emitted bootstrap chips while remote create-run is in flight. */
export const CREATE_RUN_PROGRESS_ID_PREFIX = "create-run:";

export const CREATE_RUN_PROGRESS = {
  snapshot: {
    id: `${CREATE_RUN_PROGRESS_ID_PREFIX}snapshot`,
    title: "准备沙箱快照",
    detail: "正在打包工作区（已跳过密钥与 .env）",
  },
  create: {
    id: `${CREATE_RUN_PROGRESS_ID_PREFIX}post`,
    title: "创建远程运行",
    detail: "正在向控制面提交创建请求",
  },
  subscribe: {
    id: `${CREATE_RUN_PROGRESS_ID_PREFIX}subscribe`,
    title: "连接事件流",
    detail: "正在订阅远程运行事件",
  },
} as const;

export type CreateRunProgressPhase = keyof typeof CREATE_RUN_PROGRESS;

export function isCreateRunProgressStep(step: PlanStep): boolean {
  return step.id.startsWith(CREATE_RUN_PROGRESS_ID_PREFIX);
}

/** Progress titles/details are static Chinese; still redact if a caller interpolates. */
export function sanitizeCreateRunProgressCopy(text: string): string {
  return redactCloudErrorDetail(text);
}

/**
 * Surfaces create-run wait via the existing `steps` channel (StepStrip).
 * No new SSE types, no webhook, no secrets in copy.
 */
export class CreateRunProgress {
  private owned: PlanStep[] = [];

  constructor(
    private readonly session: Session,
    private readonly emit: (event: AgentEvent) => void,
  ) {}

  begin(phase: CreateRunProgressPhase): void {
    for (const step of this.owned) {
      if (step.status === "running") step.status = "done";
    }
    const spec = CREATE_RUN_PROGRESS[phase];
    const next: PlanStep = {
      id: spec.id,
      title: sanitizeCreateRunProgressCopy(spec.title),
      status: "running",
      detail: sanitizeCreateRunProgressCopy(spec.detail),
    };
    this.owned = [...this.owned.filter((step) => step.id !== spec.id), next];
    this.flush();
  }

  /** First inbound stream event — drop bootstrap chips so the UI is the live turn. */
  handoffToStream(): void {
    if (this.owned.length === 0 && !this.session.steps.some(isCreateRunProgressStep)) return;
    this.owned = [];
    this.session.steps = this.session.steps.filter((step) => !isCreateRunProgressStep(step));
    this.emit({ type: "steps", steps: this.session.steps });
  }

  /** User abort: clear so idle has no leftover 进行中 chip (no visual zombie). */
  abort(): void {
    this.handoffToStream();
  }

  /** Mark the in-flight phase as error; keep chips so the banner + strip agree. */
  fail(): void {
    if (this.owned.length === 0) return;
    for (const step of this.owned) {
      if (step.status === "running") step.status = "error";
    }
    this.flush();
  }

  private flush(): void {
    const rest = this.session.steps.filter((step) => !isCreateRunProgressStep(step));
    this.session.steps = [...this.owned.map((step) => ({ ...step })), ...rest];
    this.emit({ type: "steps", steps: this.session.steps });
  }
}
