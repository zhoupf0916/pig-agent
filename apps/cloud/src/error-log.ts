// One log line per unhandled request error: error class, SQLSTATE/system code and the matched route pattern.
// Never the message, parameters or path values, which can carry user data or tokens.
export function requestErrorLine(error: unknown, method: string, route: string) {
  const name = error instanceof Error || (typeof error === "object" && error !== null && "name" in error)
    ? String((error as { name: unknown }).name)
    : typeof error;
  const raw = typeof error === "object" && error !== null && "code" in error ? (error as { code: unknown }).code : undefined;
  const code = typeof raw === "string" && /^[A-Za-z0-9_]{1,32}$/.test(raw) ? ` code=${raw}` : "";
  // node-postgres reports every server-side failure with name "error"; label it so the line is self-explanatory.
  const kind = name === "error" && code ? "DatabaseError" : name.slice(0, 64);
  return `Request failed: ${kind}${code} ${method} ${route}`;
}
