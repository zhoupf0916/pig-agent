const $ = (id) => document.getElementById(id);
let token = sessionStorage.getItem("pig.cloud.token") || "";
const labels = {
  queued: "排队",
  preparing: "准备容器",
  running: "执行中",
  cancelling: "停止中",
  cancelled: "已取消",
  succeeded: "完成",
  failed: "失败",
};
async function api(path, init = {}) {
  const r = await fetch(path, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });
  const data = await r.json();
  if (!r.ok) throw Error(data.error || `HTTP ${r.status}`);
  return data;
}
function node(tag, text) {
  const e = document.createElement(tag);
  e.textContent = text;
  return e;
}
async function refresh() {
  if (!token) return;
  try {
    const [overview, list, accountData, channelData, resourceData] =
      await Promise.all([
        api("/v1/admin/overview"),
        api("/v1/runs"),
        api("/v1/admin/accounts"),
        api("/v1/admin/channels"),
        api("/v1/admin/resources"),
      ]);
    $("login").hidden = true;
    $("dashboard").hidden = false;
    $("error").textContent = "";
    $("mode").textContent =
      overview.modelMode === "mock" ? "模拟模型 · 真实容器" : "真实模型渠道";
    $("counts").replaceChildren(
      ...overview.counts.map((item) => {
        const e = node("div", "");
        e.append(
          node("span", labels[item.state] || item.state),
          node("strong", String(item.count)),
        );
        return e;
      }),
    );
    if (!$("resource-form").contains(document.activeElement))
      $("resource-profile").value = resourceData.selected;
    if (!$("accounts").contains(document.activeElement))
      $("accounts").replaceChildren(
        ...accountData.accounts
          .filter((a) => a.enabled || $("show-disabled").checked)
          .map((a) => {
            const row = node(
              "p",
              `${a.name} · ${a.role} · 今日调用 ${a.calls_today}/${a.daily_call_limit} `,
            );
            const toggle = node("button", a.enabled ? "禁用" : "启用");
            toggle.onclick = () =>
              action(
                `/v1/admin/accounts/${a.id}`,
                { enabled: !a.enabled },
                "PATCH",
              );
            const revoke = node("button", "撤销登录会话");
            revoke.onclick = () =>
              action(
                `/v1/admin/accounts/${a.id}`,
                { revokeSessions: true },
                "PATCH",
              );
            const limit = node("input", "");
            limit.type = "number";
            limit.min = "0";
            limit.max = "100000";
            limit.value = a.daily_call_limit;
            limit.setAttribute("aria-label", a.name + "每日调用限额");
            const save = node("button", "保存限额");
            save.onclick = () =>
              action(
                `/v1/admin/accounts/${a.id}`,
                { dailyCallLimit: Number(limit.value) },
                "PATCH",
              );
            row.append(toggle, revoke, limit, save);
            if (a.enabled && a.role === "member") {
              const login = node("button", "新设备登录 / 续期");
              login.onclick = async () => {
                try {
                  const data = await api("/v1/admin/invitations", {
                    method: "POST",
                    body: JSON.stringify({ name: a.name, accountId: a.id }),
                  });
                  $("invite-result").textContent =
                    `${a.name} 登录邀请码（24 小时有效）：${data.invite}`;
                } catch (e) {
                  $("error").textContent = e.message;
                }
              };
              row.append(login);
            }
            return row;
          }),
      );
    $("channels").replaceChildren(
      ...channelData.channels.map((ch) => {
        const row = node(
          "p",
          `${ch.enabled ? "● 已启用" : "○ 已停用"} · ${ch.name} · ${ch.model} · ${ch.base_url} `,
        );
        const toggle = node("button", ch.enabled ? "停用" : "启用");
        toggle.onclick = () =>
          action(`/v1/admin/channels/${ch.id}/activate`, {
            enabled: !ch.enabled,
          });
        const test = node("button", "测试连接");
        test.onclick = async () => {
          try {
            const result = await api(`/v1/admin/channels/${ch.id}/test`, {
              method: "POST",
            });
            $("error").textContent = result.ok
              ? "模型连接成功"
              : `模型连接失败 ${result.status || result.error}`;
          } catch (e) {
            $("error").textContent = e.message;
          }
        };
        row.append(toggle, test);
        if (!ch.enabled) {
          const remove = node("button", "删除");
          remove.onclick = () =>
            action(`/v1/admin/channels/${ch.id}`, undefined, "DELETE");
          row.append(remove);
        }
        return row;
      }),
    );
    $("workers").replaceChildren(
      ...overview.workers.map((w) => {
        const row = node(
          "p",
          `${w.online ? "● 在线" : "○ 离线"} · ${w.id} · ${w.enabled ? "接收任务" : "排空中"} · ${w.active}/${w.capacity} 槽位 `,
        );
        const toggle = node("button", w.enabled ? "排空节点" : "恢复接单");
        toggle.onclick = async () => {
          try {
            await api(`/v1/admin/workers/${encodeURIComponent(w.id)}`, {
              method: "PATCH",
              body: JSON.stringify({ enabled: !w.enabled }),
            });
            await refresh();
          } catch (e) {
            $("error").textContent = e.message;
          }
        };
        row.append(toggle);
        const slots = node("select", "");
        slots.setAttribute("aria-label", `${w.id} 并发槽位`);
        for (let n = 1; n <= 3; n++) {
          const option = node("option", `${n} 并发`);
          option.value = String(n);
          option.selected = w.capacity === n;
          slots.append(option);
        }
        slots.onchange = async () => {
          try {
            await api(`/v1/admin/workers/${encodeURIComponent(w.id)}`, {
              method: "PATCH",
              body: JSON.stringify({ capacity: Number(slots.value) }),
            });
            await refresh();
          } catch (e) {
            $("error").textContent = e.message;
          }
        };
        row.append(slots);
        return row;
      }),
    );
    $("runs").replaceChildren(
      ...list.runs.map((run) => {
        const tr = node("tr", "");
        tr.append(
          node("td", run.prompt.slice(0, 80)),
          node("td", run.owner_id),
          node("td", labels[run.state] || run.state),
          node("td", String(run.model_calls)),
        );
        const actions = node("td", "");
        const detail = node("button", "详情");
        detail.onclick = async () => {
          try {
            $("detail").textContent = JSON.stringify(
              await api("/v1/runs/" + run.id),
              null,
              2,
            );
          } catch (e) {
            $("error").textContent = e.message;
          }
        };
        actions.append(detail);
        if (["queued", "preparing", "running"].includes(run.state)) {
          const cancel = node("button", "取消");
          cancel.onclick = async () => {
            try {
              await api(`/v1/runs/${run.id}/abort`, { method: "POST" });
              await refresh();
            } catch (e) {
              $("error").textContent = e.message;
            }
          };
          actions.append(cancel);
        }
        tr.append(actions);
        return tr;
      }),
    );
    $("schedules").replaceChildren(
      ...(overview.schedules || []).map((s) =>
        node(
          "p",
          `${s.enabled ? "已启用" : "已停用"} · ${s.name} · ${s.owner_id} · ${s.cron || "仅手动"} · ${s.timezone} · 下次 ${s.next_fire_at ? new Date(s.next_fire_at).toLocaleString() : "—"}${s.last_error ? " · " + s.last_error : ""}`,
        ),
      ),
    );
    $("audit").replaceChildren(
      ...overview.audit
        .slice(0, 15)
        .map((a) =>
          node(
            "p",
            `${new Date(a.created_at).toLocaleString()} · ${a.actor} · ${a.action} · ${a.run_id}`,
          ),
        ),
    );
  } catch (e) {
    $("error").textContent = e.message;
    $("login").hidden = false;
    $("dashboard").hidden = true;
  }
}
$("login-form").onsubmit = async (e) => {
  e.preventDefault();
  token = $("token").value.trim();
  try {
    await api("/v1/admin/overview");
    sessionStorage.setItem("pig.cloud.token", token);
    $("token").value = "";
    await refresh();
  } catch (e) {
    $("error").textContent = e.message;
    token = "";
  }
};
$("logout").onclick = async () => {
  try {
    await api("/v1/logout", { method: "POST" });
  } catch {}
  $("invite-result").textContent = "";
  $("channel-key").value = "";
  sessionStorage.removeItem("pig.cloud.token");
  token = "";
  $("login").hidden = false;
  $("dashboard").hidden = true;
};
void refresh();
setInterval(() => void refresh(), 3000);

async function action(path, body, method = "POST") {
  try {
    await api(path, { method, body: JSON.stringify(body) });
    await refresh();
  } catch (e) {
    $("error").textContent = e.message;
  }
}
$("invite-form").onsubmit = async (e) => {
  e.preventDefault();
  try {
    const data = await api("/v1/admin/invitations", {
      method: "POST",
      body: JSON.stringify({ name: $("invite-name").value }),
    });
    $("invite-result").textContent =
      `一次性邀请码（24 小时有效）：${data.invite}`;
    $("invite-name").value = "";
  } catch (e) {
    $("error").textContent = e.message;
  }
};
$("channel-form").onsubmit = async (e) => {
  e.preventDefault();
  try {
    await api("/v1/admin/channels", {
      method: "POST",
      body: JSON.stringify({
        name: $("channel-name").value,
        baseUrl: $("channel-base").value,
        model: $("channel-model").value,
        apiKey: $("channel-key").value,
      }),
    });
    $("channel-key").value = "";
    await refresh();
  } catch (e) {
    $("error").textContent = e.message;
  }
};

$("resource-form").onsubmit = (e) => {
  e.preventDefault();
  void action(
    "/v1/admin/resources",
    { profile: $("resource-profile").value },
    "PUT",
  );
};

$("show-disabled").onchange = () => void refresh();
