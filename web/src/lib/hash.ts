export type AppRoute =
  | { name: "workstation"; sessionId?: string }
  | { name: "projects"; projectId?: string; assetId?: string; todoId?: string }
  | { name: "experts"; expertId?: string }
  | { name: "automations"; automationId?: string }
  | { name: "search"; q?: string };

export function splitHash(hash: string): { path: string; query: URLSearchParams } {
  const raw = hash.replace(/^#/, "") || "/";
  const withSlash = raw.startsWith("/") ? raw : `/${raw}`;
  const q = withSlash.indexOf("?");
  if (q === -1) return { path: withSlash, query: new URLSearchParams() };
  return {
    path: withSlash.slice(0, q) || "/",
    query: new URLSearchParams(withSlash.slice(q + 1)),
  };
}

export function parseHash(hash = window.location.hash): AppRoute {
  const { path, query } = splitHash(hash);
  const parts = path.split("/").filter(Boolean);
  if (parts[0] === "projects") {
    return {
      name: "projects",
      projectId: parts[1],
      assetId: query.get("asset") || undefined,
      todoId: query.get("todo") || undefined,
    };
  }
  if (parts[0] === "experts") {
    return { name: "experts", expertId: parts[1] };
  }
  if (parts[0] === "automations") {
    return { name: "automations", automationId: parts[1] };
  }
  if (parts[0] === "search") {
    return { name: "search", q: query.get("q") || undefined };
  }
  if (parts[0] === "sessions" && parts[1]) {
    return { name: "workstation", sessionId: parts[1] };
  }
  return { name: "workstation" };
}

export function projectsHash(
  projectId?: string,
  extra?: { assetId?: string; todoId?: string },
): string {
  if (!projectId) return "#/projects";
  const qs = new URLSearchParams();
  if (extra?.assetId) qs.set("asset", extra.assetId);
  if (extra?.todoId) qs.set("todo", extra.todoId);
  const q = qs.toString();
  return q ? `#/projects/${projectId}?${q}` : `#/projects/${projectId}`;
}

export function expertsHash(expertId?: string): string {
  return expertId ? `#/experts/${expertId}` : "#/experts";
}

export function automationsHash(automationId?: string): string {
  return automationId ? `#/automations/${automationId}` : "#/automations";
}

export function workstationHash(): string {
  return "#/";
}

export function sessionHash(sessionId: string): string {
  return `#/sessions/${sessionId}`;
}

export function searchHash(q?: string): string {
  const trimmed = q?.trim();
  return trimmed ? `#/search?q=${encodeURIComponent(trimmed)}` : "#/search";
}
