export type AppRoute =
  | { name: "workstation" }
  | { name: "projects"; projectId?: string };

export function parseHash(hash = window.location.hash): AppRoute {
  const raw = hash.replace(/^#/, "") || "/";
  const path = raw.startsWith("/") ? raw : `/${raw}`;
  const parts = path.split("/").filter(Boolean);
  if (parts[0] === "projects") {
    return { name: "projects", projectId: parts[1] };
  }
  return { name: "workstation" };
}

export function projectsHash(projectId?: string): string {
  return projectId ? `#/projects/${projectId}` : "#/projects";
}

export function workstationHash(): string {
  return "#/";
}
