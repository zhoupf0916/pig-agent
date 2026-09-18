import type {
  Project,
  ProjectAsset,
  ProjectInvite,
  ProjectMember,
  ProjectSummary,
  ProjectTodo,
} from "../types";
import {
  browserSessionListClock,
  type SessionListSyncClock,
} from "./session-list-sync";

/** Read-only projects refresh. Same-host tabs pick up board / assets / members. */
export const PROJECTS_SYNC_POLL_MS = 2_000;

/** List-side fields `#/projects` actually paints (name) plus updatedAt / counts. */
export type ProjectListSyncFields = Pick<
  ProjectSummary,
  "id" | "name" | "updatedAt" | "todoCount" | "assetCount" | "memberCount" | "sessionCount"
>;

/** Open-detail fields the board / assets / members / activity sections paint. */
export type ProjectDetailSyncFields = Pick<
  Project,
  "id" | "name" | "updatedAt" | "todos" | "assets" | "members" | "invites"
> & {
  /** Present on GET /api/projects/:id; optional on list-only fixtures. */
  messages?: Project["messages"];
};

export function normalizeProjectText(value?: string | null): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

export function projectListSyncKey(row: ProjectListSyncFields): string {
  return [
    row.id,
    normalizeProjectText(row.name) ?? "",
    normalizeProjectText(row.updatedAt) ?? "",
    String(row.todoCount ?? 0),
    String(row.assetCount ?? 0),
    String(row.memberCount ?? 0),
    String(row.sessionCount ?? 0),
  ].join("\u0001");
}

function todoSyncKey(todo: ProjectTodo): string {
  return [
    todo.id,
    normalizeProjectText(todo.title) ?? "",
    todo.status,
    normalizeProjectText(todo.updatedAt) ?? "",
    normalizeProjectText(todo.sessionId) ?? "",
  ].join("\u0001");
}

function assetSyncKey(asset: ProjectAsset): string {
  return [
    asset.id,
    normalizeProjectText(asset.filename) ?? "",
    String(asset.size),
    normalizeProjectText(asset.mimeType) ?? "",
    normalizeProjectText(asset.updatedAt) ?? "",
    normalizeProjectText(asset.sourceSessionId) ?? "",
    normalizeProjectText(asset.sourceArtifactPath) ?? "",
  ].join("\u0001");
}

function memberSyncKey(member: ProjectMember): string {
  return [
    member.id,
    normalizeProjectText(member.userId) ?? "",
    normalizeProjectText(member.displayName) ?? "",
    member.role,
    normalizeProjectText(member.joinedAt) ?? "",
  ].join("\u0001");
}

function inviteSyncKey(invite: ProjectInvite): string {
  return [
    invite.id,
    normalizeProjectText(invite.displayName) ?? "",
    invite.status,
    normalizeProjectText(invite.note) ?? "",
    normalizeProjectText(invite.resolvedAt) ?? "",
    normalizeProjectText(invite.memberId) ?? "",
  ].join("\u0001");
}

function messageSyncKey(message: Project["messages"][number]): string {
  return [
    message.id,
    message.kind,
    normalizeProjectText(message.body) ?? "",
    normalizeProjectText(message.actorId) ?? "",
    normalizeProjectText(message.createdAt) ?? "",
    normalizeProjectText(message.sessionId) ?? "",
  ].join("\u0001");
}

export function projectDetailSyncKey(row: ProjectDetailSyncFields): string {
  return [
    row.id,
    normalizeProjectText(row.name) ?? "",
    normalizeProjectText(row.updatedAt) ?? "",
    row.todos.map(todoSyncKey).join("\u0002"),
    row.assets.map(assetSyncKey).join("\u0002"),
    row.members.map(memberSyncKey).join("\u0002"),
    (row.invites ?? []).map(inviteSyncKey).join("\u0002"),
    (row.messages ?? []).map(messageSyncKey).join("\u0002"),
  ].join("\u0001");
}

function assignProjectListRow<T extends ProjectListSyncFields>(
  base: T,
  snap: ProjectListSyncFields,
): T {
  const next = { ...base };
  const name = normalizeProjectText(snap.name);
  const updatedAt = normalizeProjectText(snap.updatedAt);
  if (name) next.name = name;
  if (updatedAt) next.updatedAt = updatedAt;
  next.todoCount = snap.todoCount;
  next.assetCount = snap.assetCount;
  next.memberCount = snap.memberCount;
  next.sessionCount = snap.sessionCount;
  return next;
}

/**
 * Patch list-visible summary fields onto existing rows by id.
 * Same array reference when nothing list-visible changed.
 * Does not add / remove rows (create / delete stay on the existing write paths).
 */
export function applyProjectsListSnapshot<T extends ProjectListSyncFields>(
  prev: T[],
  next: ProjectListSyncFields[],
): T[] {
  const byId = new Map(next.map((row) => [row.id, row]));
  let changed = false;
  const applied = prev.map((row) => {
    const snap = byId.get(row.id);
    if (!snap) return row;
    const merged = assignProjectListRow(row, snap);
    if (projectListSyncKey(row) === projectListSyncKey(merged)) return row;
    changed = true;
    return merged;
  });
  return changed ? applied : prev;
}

function assignProjectDetail<T extends ProjectDetailSyncFields>(
  base: T,
  snap: ProjectDetailSyncFields,
): T {
  return {
    ...base,
    name: normalizeProjectText(snap.name) ?? base.name,
    updatedAt: normalizeProjectText(snap.updatedAt) ?? base.updatedAt,
    todos: snap.todos.map((todo) => ({ ...todo })),
    assets: snap.assets.map((asset) => ({ ...asset })),
    members: snap.members.map((member) => ({ ...member })),
    invites: (snap.invites ?? []).map((invite) => ({ ...invite })),
    ...(Array.isArray(snap.messages)
      ? { messages: snap.messages.map((message) => ({ ...message })) }
      : {}),
  };
}

/**
 * Patch board / assets / members (and pending invites) on the open project.
 * Same reference when nothing visible changed (avoids remounting the page).
 * Leaves instruction / inviteToken alone.
 * Messages apply when the GET /api/projects/:id snapshot includes them
 * (sessionId catch-up after session delete; body / kind / timestamp stay).
 * `next === null` means the open project was deleted (gone from GET /api/projects).
 * Read-only: never POSTs todos / assets / members or writes events.jsonl.
 */
export function applyProjectDetailSnapshot<T extends ProjectDetailSyncFields>(
  prev: T | null,
  next: ProjectDetailSyncFields | null,
): T | null {
  if (next === null) return null;
  if (!prev) return prev;
  if (next.id !== prev.id) return prev;
  const merged = assignProjectDetail(prev, next);
  if (projectDetailSyncKey(prev) === projectDetailSyncKey(merged)) {
    return prev;
  }
  return merged;
}

/**
 * When the open id is still in GET /api/projects, keep it.
 * When it is gone, pick the next list row (or null to clear).
 * Does not load project detail bodies.
 */
export function nextOpenProjectId(
  openId: string | null | undefined,
  list: Array<{ id: string }>,
): string | null {
  if (!openId) return null;
  if (list.some((item) => item.id === openId)) return openId;
  return list[0]?.id ?? null;
}

/**
 * AN-02 nail: GET /api/projects/:id only while the list still contains that id.
 * Once the list snapshot says the open id is gone, callers must rewrite hash /
 * open state first and must not request `:id`.
 */
export function shouldFetchProjectDetail(
  openId: string | null | undefined,
  list: Array<{ id: string }>,
): boolean {
  return Boolean(openId && list.some((item) => item.id === openId));
}

/**
 * Periodically GET the existing projects list (and on tab focus / visible).
 * Hidden tabs skip interval ticks; becoming visible fetches immediately.
 * Open detail also GET /api/projects/:id — never force-fetch when that detail is not open.
 * If the list snapshot lacks the open id, rewrite open state first and do not GET `:id`.
 */
export function startProjectsSync(opts: {
  fetchList: () => Promise<ProjectListSyncFields[]>;
  onList: (next: ProjectListSyncFields[]) => void;
  selectedId?: string;
  fetchSelected?: (id: string) => Promise<ProjectDetailSyncFields | null>;
  onSelected?: (next: ProjectDetailSyncFields) => void;
  onOpenId?: (nextId: string | null) => void;
  intervalMs?: number;
  clock?: SessionListSyncClock;
}): () => void {
  const intervalMs = opts.intervalMs ?? PROJECTS_SYNC_POLL_MS;
  const clock = opts.clock ?? browserSessionListClock();
  let stopped = false;
  let inFlight = false;

  const refresh = async () => {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      const list = await opts.fetchList();
      if (stopped) return;
      opts.onList(list);
      const selectedId = opts.selectedId;
      if (selectedId && !shouldFetchProjectDetail(selectedId, list)) {
        // list confirms gone — update hash / open state first; never GET :id
        opts.onOpenId?.(nextOpenProjectId(selectedId, list));
        return;
      }
      if (selectedId && opts.fetchSelected && opts.onSelected) {
        try {
          const selected = await opts.fetchSelected(selectedId);
          if (!stopped && selected && selected.id === selectedId) {
            opts.onSelected(selected);
          }
        } catch {
          // keep the last good open board / assets / members (list already applied)
        }
      }
    } catch {
      // keep the last good projects list
    } finally {
      inFlight = false;
    }
  };

  const tick = () => {
    if (clock.isVisible()) void refresh();
  };

  void refresh();
  const timer = clock.setInterval(tick, intervalMs);
  clock.addListener("visibilitychange", tick);
  clock.addListener("focus", tick);

  return () => {
    stopped = true;
    clock.clearInterval(timer);
    clock.removeListener("visibilitychange", tick);
    clock.removeListener("focus", tick);
  };
}
