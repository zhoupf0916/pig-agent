import { redactSecretsForDisplay } from "./remote-retry";
import {
  browserSessionListClock,
  type SessionListSyncClock,
} from "./session-list-sync";

/** Read-only open-file preview refresh. Same-host tabs pick up GET /api/workspace/file. */
export const WORKSPACE_FILE_POLL_MS = 2_000;

export type WorkspaceFilePreview = {
  path: string;
  content: string;
  binary: boolean;
  size: number;
};

/**
 * Fields the workstation file preview paints. Secrets are redacted with the
 * existing banner helper — never show provider keys / tokens in plaintext.
 */
export function sanitizeWorkspaceFilePreview(
  file: WorkspaceFilePreview,
): WorkspaceFilePreview {
  return {
    path: file.path,
    content: file.binary ? "" : redactSecretsForDisplay(file.content),
    binary: file.binary,
    size: file.size,
  };
}

/** size + path + binary + content — size is the cheap change hint from the existing GET. */
export function workspaceFileSyncKey(file: WorkspaceFilePreview | null): string {
  if (!file) return "";
  return [file.path, file.binary ? "1" : "0", String(file.size), file.content].join("\u0001");
}

/**
 * Replace the open preview with a GET /api/workspace/file snapshot.
 * Same reference when nothing visible changed (avoids remounting the preview pane).
 * Read-only: never writes workspace files, session JSON, or events.jsonl.
 */
export function applyWorkspaceFileSnapshot(
  prev: WorkspaceFilePreview | null,
  next: WorkspaceFilePreview,
): WorkspaceFilePreview {
  const clean = sanitizeWorkspaceFilePreview(next);
  if (prev && workspaceFileSyncKey(prev) === workspaceFileSyncKey(clean)) {
    return prev;
  }
  return clean;
}

/**
 * Periodically GET the already-open workspace file (and on tab focus / visible).
 * Hidden tabs skip interval ticks; becoming visible fetches immediately.
 * No path → no fetch (preview closed).
 */
export function startWorkspaceFileSync(opts: {
  path: string;
  fetchFile: (path: string) => Promise<WorkspaceFilePreview>;
  onFile: (next: WorkspaceFilePreview) => void;
  intervalMs?: number;
  clock?: SessionListSyncClock;
}): () => void {
  const intervalMs = opts.intervalMs ?? WORKSPACE_FILE_POLL_MS;
  const clock = opts.clock ?? browserSessionListClock();
  const path = opts.path;
  let stopped = false;
  let inFlight = false;

  const refresh = async () => {
    if (stopped || inFlight || !path) return;
    inFlight = true;
    try {
      const next = await opts.fetchFile(path);
      if (!stopped) opts.onFile(next);
    } catch {
      // keep the last good preview
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
