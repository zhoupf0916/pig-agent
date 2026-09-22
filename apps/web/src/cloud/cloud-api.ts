let identityRevision = 0;
export function advanceCloudIdentity() {
  identityRevision++;
}
export async function cloudRequest(
  path: string,
  method = "GET",
  body?: unknown,
  extraHeaders?: Record<string, string>,
) {
  const startedRevision = identityRevision;
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(extraHeaders || {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (startedRevision !== identityRevision)
    throw new Error("账号已切换，已忽略旧请求");
  if (!response.ok) {
    if (response.status === 401 && startedRevision === identityRevision)
      window.dispatchEvent(new Event("cloud-auth-expired"));
    throw new Error(
      data.error || data.message || `请求失败 (${response.status})`,
    );
  }
  return data;
}
