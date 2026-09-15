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

/** Host-emitted chips while follow-up / event-stream reconnect is in flight (Milestone X). */
export const FOLLOW_UP_PROGRESS_ID_PREFIX = "follow-up:";

export const FOLLOW_UP_PROGRESS = {
  followup: {
    id: `${FOLLOW_UP_PROGRESS_ID_PREFIX}post`,
    title: "继续跟进",
    detail: "正在向已有运行发送跟进",
  },
  reconnect: {
    id: `${FOLLOW_UP_PROGRESS_ID_PREFIX}subscribe`,
    title: "重新连接事件流",
    detail: "正在订阅已有运行的事件",
  },
} as const;

export type FollowUpProgressPhase = keyof typeof FOLLOW_UP_PROGRESS;

/** Host-emitted chips while local-stub isolate materialize is in flight (Milestone AD). */
export const LOCAL_STUB_PROGRESS_ID_PREFIX = "local-stub:";

export const LOCAL_STUB_PROGRESS = {
  materialize: {
    id: `${LOCAL_STUB_PROGRESS_ID_PREFIX}materialize`,
    title: "准备隔离工作区",
    detail: "正在复制工作区（已跳过密钥与 .env）",
  },
  start: {
    id: `${LOCAL_STUB_PROGRESS_ID_PREFIX}start`,
    title: "启动本机循环",
    detail: "即将在隔离副本上启动本机 Pig 循环",
  },
} as const;

export type LocalStubProgressPhase = keyof typeof LOCAL_STUB_PROGRESS;
export type RemoteWaitProgressPhase =
  | CreateRunProgressPhase
  | FollowUpProgressPhase
  | LocalStubProgressPhase;

export function isCreateRunProgressStep(step: PlanStep): boolean {
  return step.id.startsWith(CREATE_RUN_PROGRESS_ID_PREFIX);
}

export function isFollowUpProgressStep(step: PlanStep): boolean {
  return step.id.startsWith(FOLLOW_UP_PROGRESS_ID_PREFIX);
}

export function isLocalStubProgressStep(step: PlanStep): boolean {
  return step.id.startsWith(LOCAL_STUB_PROGRESS_ID_PREFIX);
}

export function isRemoteWaitProgressStep(step: PlanStep): boolean {
  return (
    isCreateRunProgressStep(step) || isFollowUpProgressStep(step) || isLocalStubProgressStep(step)
  );
}

function specFor(phase: RemoteWaitProgressPhase): { id: string; title: string; detail: string } {
  if (phase in CREATE_RUN_PROGRESS) return CREATE_RUN_PROGRESS[phase as CreateRunProgressPhase];
  if (phase in FOLLOW_UP_PROGRESS) return FOLLOW_UP_PROGRESS[phase as FollowUpProgressPhase];
  return LOCAL_STUB_PROGRESS[phase as LocalStubProgressPhase];
}

function catalogKeep(phase: RemoteWaitProgressPhase): (step: PlanStep) => boolean {
  if (phase in CREATE_RUN_PROGRESS) return isCreateRunProgressStep;
  if (phase in FOLLOW_UP_PROGRESS) return isFollowUpProgressStep;
  return isLocalStubProgressStep;
}

/** Progress titles/details are static Chinese; still redact if a caller interpolates. */
export function sanitizeCreateRunProgressCopy(text: string): string {
  return redactCloudErrorDetail(text);
}

/**
 * Surfaces create-run / follow-up / local-stub wait via the existing `steps` channel (StepStrip).
 * Same state machine as Milestone W — three catalogs, never mixed. No new SSE types,
 * no webhook, no secrets in copy.
 */
export class CreateRunProgress {
  private owned: PlanStep[] = [];

  constructor(
    private readonly session: Session,
    private readonly emit: (event: AgentEvent) => void,
  ) {}

  begin(phase: RemoteWaitProgressPhase): void {
    const keep = catalogKeep(phase);
    this.owned = this.owned.filter(keep);
    for (const step of this.owned) {
      if (step.status === "running") step.status = "done";
    }
    const spec = specFor(phase);
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
    if (this.owned.length === 0 && !this.session.steps.some(isRemoteWaitProgressStep)) return;
    this.owned = [];
    this.session.steps = this.session.steps.filter((step) => !isRemoteWaitProgressStep(step));
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
    const rest = this.session.steps.filter((step) => !isRemoteWaitProgressStep(step));
    this.session.steps = [...this.owned.map((step) => ({ ...step })), ...rest];
    this.emit({ type: "steps", steps: this.session.steps });
  }
}
