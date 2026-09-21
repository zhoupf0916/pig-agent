const $ = (id) => document.getElementById(id);
let token = sessionStorage.getItem("pig.cloud.token") || "";
let snapshot,
  refreshing = false,
  selectedRun = null,
  detailBusy = false;
let connectionError = false;
let detailVersion = "";
let generation = 0,
  feedbackTimer;
const dirtyForms = new Set();
const accountDrafts = new Map();
const labels = {
  queued: "排队",
  preparing: "准备容器",
  running: "执行中",
  cancelling: "停止中",
  cancelled: "已取消",
  succeeded: "完成",
  failed: "失败",
};
const policyFields = {
  globalConcurrency: "global-concurrency",
  userConcurrency: "user-concurrency",
  projectConcurrency: "project-concurrency",
  queueLimit: "queue-limit",
  queueTimeoutSeconds: "queue-timeout",
};
const dates = (v) =>
  v ? new Date(v).toLocaleString("zh-CN", { hour12: false }) : "—";
function node(tag, text = "", className = "") {
  const e = document.createElement(tag);
  e.textContent = text;
  if (className) e.className = className;
  return e;
}
function empty(text) {
  return node("div", text, "empty");
}
function badge(state, text = labels[state] || state) {
  return node("span", text, `badge ${state}`);
}
function showError(message) {
  $("error").textContent = message;
  $("error").hidden = !message;
}
function feedback(message) {
  clearTimeout(feedbackTimer);
  $("feedback").textContent = message;
  $("feedback").hidden = false;
  feedbackTimer = setTimeout(() => {
    $("feedback").hidden = true;
  }, 7000);
}
function navigate() {
  const page = location.hash.slice(1) || "overview";
  const valid = [
    "overview",
    "runs",
    "workers",
    "settings",
    "accounts",
    "audit",
  ].includes(page)
    ? page
    : "overview";
  for (const e of document.querySelectorAll("[data-view]"))
    e.hidden = e.dataset.view !== valid;
  for (const e of document.querySelectorAll("[data-page]")) {
    if (e.dataset.page === valid) e.setAttribute("aria-current", "page");
    else e.removeAttribute("aria-current");
  }
}
function connected(value) {
  $("login").hidden = value;
  $("dashboard").hidden = !value;
  $("navigation").hidden = !value;
  $("logout").hidden = !value;
  $("refresh").hidden = !value;
}
async function api(path, init = {}) {
  const response = await fetch(path, {
    ...init,
    signal: AbortSignal.timeout(30000),
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(
      data.error || `请求失败（HTTP ${response.status}）`,
    );
    error.status = response.status;
    throw error;
  }
  return data;
}
async function action(
  path,
  body,
  method = "POST",
  message = "操作已保存",
  source,
) {
  if (source) source.disabled = true;
  const before = generation;
  try {
    await api(path, {
      method,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (before !== generation) return false;
    showError("");
    feedback(message);
    await refresh();
    return true;
  } catch (e) {
    if (before === generation) showError(e.message);
    return false;
  } finally {
    if (source?.isConnected) source.disabled = false;
  }
}
function button(text, handler, className = "") {
  const b = node("button", text, className);
  b.type = "button";
  b.onclick = () => handler(b);
  return b;
}
function renderOverview() {
  const { overview } = snapshot,
    counts = Object.fromEntries(
      overview.counts.map((x) => [x.state, Number(x.count)]),
    );
  const cards = [
    ["等待执行", counts.queued || 0, "队列中的任务"],
    [
      "正在执行",
      (counts.running || 0) +
        (counts.preparing || 0) +
        (counts.cancelling || 0),
      "准备、执行及停止中的任务",
    ],
    ["已完成", counts.succeeded || 0, "累计成功运行"],
    ["失败", counts.failed || 0, "累计失败运行"],
  ];
  $("counts").replaceChildren(
    ...cards.map(([title, count, caption]) => {
      const e = node("div");
      e.append(
        node("span", title),
        node("strong", String(count)),
        node("small", caption),
      );
      return e;
    }),
  );
  $("mode").textContent =
    overview.modelMode === "mock" ? "模拟模型 · 真实容器" : "真实模型渠道";
  const available = overview.workers.filter(
    (w) => w.online && w.enabled && !w.draining,
  );
  const active = overview.workers.reduce((sum, w) => sum + Number(w.active), 0);
  const capacity = available.reduce(
    (sum, w) => sum + Math.min(w.capacity, w.reported_capacity ?? w.capacity),
    0,
  );
  $("cluster-summary").replaceChildren(
    node(
      "p",
      `${available.length} 个节点可接单 · ${overview.workers.length} 个注册节点`,
    ),
    node(
      "p",
      `${active} 个有效任务占用槽位 · 可接单节点总容量 ${capacity}`,
      "muted",
    ),
  );
  const offline = overview.workers.filter((w) => !w.online).length;
  $("attention").replaceChildren(
    node(
      "p",
      offline
        ? `${offline} 个 Runner 已离线`
        : overview.workers.length
          ? "所有已注册 Runner 心跳正常"
          : "尚未注册 Runner",
    ),
    node(
      "p",
      !available.length
        ? "暂无可接单节点，新任务将等待资源。"
        : `${counts.queued || 0} 个任务等待调度。可在任务详情中检查失败原因。`,
      "muted",
    ),
  );
  $("recent-runs").replaceChildren(
    ...(snapshot.list.runs.length
      ? snapshot.list.runs.slice(0, 5).map((r) => {
          const row = node("div", "", "recent-row");
          row.append(
            button(r.prompt || r.id, () => openDetail(r.id)),
            badge(r.state),
          );
          return row;
        })
      : [empty("还没有运行记录。从 Web 或桌面工作台选择远端执行开始。")]),
  );
}
function renderRuns() {
  const query = $("run-search").value.trim().toLowerCase(),
    state = $("run-state").value;
  const runs = snapshot.list.runs.filter(
    (r) =>
      (state === "all" || r.state === state) &&
      `${r.prompt} ${r.id} ${r.owner_id}`.toLowerCase().includes(query),
  );
  $("run-count").textContent = `${runs.length} 条记录`;
  $("runs").replaceChildren(
    ...runs.map((r) => {
      const row = node("tr");
      const prompt = node("td", r.prompt.slice(0, 90));
      prompt.title = r.prompt;
      prompt.append(node("span", r.id, "subline"));
      const status = node("td");
      status.append(badge(r.state));
      const actions = node("td");
      actions.append(button("详情与日志", () => openDetail(r.id)));
      if (["queued", "preparing", "running"].includes(r.state))
        actions.append(
          button(
            "取消",
            (b) =>
              action(
                `/v1/runs/${r.id}/abort`,
                undefined,
                "POST",
                "取消请求已提交，执行容器正在回收",
                b,
              ),
            "danger",
          ),
        );
      row.append(
        prompt,
        node(
          "td",
          snapshot.accountData.accounts.find((a) => a.id === r.owner_id)
            ?.name || r.owner_id,
        ),
        status,
        node("td", String(r.model_calls)),
        actions,
      );
      return row;
    }),
  );
  if (!runs.length) {
    const row = node("tr"),
      cell = node("td", "没有符合条件的任务", "empty");
    cell.colSpan = 5;
    row.append(cell);
    $("runs").append(row);
  }
}
function renderWorkers() {
  if (
    $("workers").contains(document.activeElement) &&
    document.activeElement?.tagName === "SELECT"
  )
    return;
  $("workers").replaceChildren(
    ...snapshot.overview.workers.map((w) => {
      const card = node("article", "", "panel"),
        heading = node("div", "", "worker-heading");
      heading.append(
        node("h2", w.id),
        badge(
          w.online ? "online" : "offline",
          w.online ? (w.draining || !w.enabled ? "排空中" : "在线") : "离线",
        ),
      );
      const meta = node("dl", "", "worker-meta"),
        effective = Math.min(w.capacity, w.reported_capacity ?? w.capacity);
      for (const [label, value] of [
        ["任务 / 有效容量", `${w.active} / ${effective}`],
        ["上报容量", String(w.reported_capacity ?? w.capacity)],
        ["最近心跳", dates(w.seen_at)],
        ["支持规格", w.profiles?.length ? w.profiles.join(" / ") : "未上报"],
      ]) {
        const pair = node("div");
        pair.append(node("dt", label), node("dd", value));
        meta.append(pair);
      }
      const meter = node("div", "", "meter"),
        fill = node("span");
      fill.style.width = `${Math.min(100, (Number(w.active) / Math.max(1, effective)) * 100)}%`;
      meter.append(fill);
      const actions = node("div", "", "worker-actions"),
        label = node("label", "配置并发槽位"),
        slots = node("select");
      slots.setAttribute("aria-label", `${w.id} 并发槽位`);
      for (let n = 1; n <= 16; n++) {
        const option = node("option", String(n));
        option.value = String(n);
        option.selected = w.capacity === n;
        slots.append(option);
      }
      slots.onchange = async () => {
        const previous = w.capacity;
        if (
          !(await action(
            `/v1/admin/workers/${encodeURIComponent(w.id)}`,
            { capacity: Number(slots.value) },
            "PATCH",
            "节点容量已保存，对后续任务领取生效",
            slots,
          ))
        )
          slots.value = String(previous);
        else w.capacity = Number(slots.value);
      };
      label.append(slots);
      actions.append(
        label,
        button(w.enabled ? "排空节点" : "恢复接单", (b) =>
          action(
            `/v1/admin/workers/${encodeURIComponent(w.id)}`,
            { enabled: !w.enabled },
            "PATCH",
            w.enabled ? "节点已停止接单，已有任务继续执行" : "节点已恢复接单",
            b,
          ),
        ),
      );
      card.append(heading, meta, meter, actions);
      return card;
    }),
  );
  if (!snapshot.overview.workers.length)
    $("workers").append(
      empty("暂无 Runner 注册。启动连接此控制面的 Worker 后，节点会自动出现。"),
    );
}
function renderAccounts() {
  if (
    $("accounts").contains(document.activeElement) &&
    document.activeElement?.tagName === "INPUT"
  )
    return;
  const accounts = snapshot.accountData.accounts.filter(
    (a) => a.enabled || $("show-disabled").checked,
  );
  $("accounts").replaceChildren(
    ...accounts.map((a) => {
      const card = node("article", "", "panel"),
        heading = node("div", "", "row-heading");
      heading.append(
        node("h2", a.name),
        badge(
          a.enabled ? "online" : "offline",
          `${a.role === "admin" ? "管理员" : "成员"} · ${a.enabled ? "启用" : "禁用"}`,
        ),
      );
      card.append(
        heading,
        node(
          "p",
          `今日调用 ${a.calls_today} / ${a.daily_call_limit} · ${a.id}`,
          "hint",
        ),
      );
      const quota = node("form", "", "account-quota"),
        label = node("label", "每日调用限额（UTC）"),
        input = node("input");
      input.type = "number";
      input.min = "0";
      input.max = "100000";
      input.step = "1";
      input.required = true;
      input.value = accountDrafts.get(a.id) ?? a.daily_call_limit;
      input.setAttribute("aria-label", `${a.name}每日调用限额`);
      input.oninput = () => accountDrafts.set(a.id, input.value);
      label.append(input);
      const save = node("button", "保存限额");
      quota.append(
        label,
        save,
        button("还原", () => {
          accountDrafts.delete(a.id);
          renderAccounts();
        }),
      );
      quota.onsubmit = async (event) => {
        event.preventDefault();
        if (
          await action(
            `/v1/admin/accounts/${a.id}`,
            { dailyCallLimit: Number(input.value) },
            "PATCH",
            "账号每日调用限额已保存",
            save,
          )
        ) {
          accountDrafts.delete(a.id);
          input.blur();
          await refresh();
        }
      };
      card.append(quota);
      const actions = node("div", "", "actions");
      actions.append(
        button(a.enabled ? "禁用账号" : "启用账号", (b) =>
          action(
            `/v1/admin/accounts/${a.id}`,
            { enabled: !a.enabled },
            "PATCH",
            "账号访问权限已更新",
            b,
          ),
        ),
        button("撤销登录会话", (b) =>
          action(
            `/v1/admin/accounts/${a.id}`,
            { revokeSessions: true },
            "PATCH",
            "该账号的登录会话已撤销",
            b,
          ),
        ),
      );
      if (a.enabled && a.role === "member")
        actions.append(
          button("新设备登录 / 续期", async (b) => {
            const before = generation;
            b.disabled = true;
            try {
              const data = await api("/v1/admin/invitations", {
                method: "POST",
                body: JSON.stringify({ name: a.name, accountId: a.id }),
              });
              if (before !== generation) return;
              $("invite-result").textContent =
                `${a.name} 登录邀请码（24 小时有效）：${data.invite}`;
              $("invite-result").scrollIntoView({
                block: "center",
                behavior: "smooth",
              });
              feedback("一次性登录邀请码已生成");
            } catch (e) {
              if (before === generation) showError(e.message);
            } finally {
              if (before === generation) b.disabled = false;
            }
          }),
        );
      card.append(actions);
      return card;
    }),
  );
  if (!accounts.length)
    $("accounts").append(empty("暂无符合条件的账号。创建邀请码以邀请新成员。"));
}
function renderSettings() {
  if (!dirtyForms.has("resource-form"))
    $("resource-profile").value = snapshot.resourceData.selected;
  if (!dirtyForms.has("policy-form"))
    for (const [key, id] of Object.entries(policyFields))
      $(id).value = snapshot.policyData[key];
  if ($("channels").querySelector("button:disabled")) return;
  $("channels").replaceChildren(
    ...snapshot.channelData.channels.map((ch) => {
      const row = node("div", "", "list-row"),
        heading = node("div", "", "row-heading");
      heading.append(
        node("h3", ch.name),
        badge(
          ch.enabled ? "online" : "cancelled",
          ch.enabled ? "已启用" : "已停用",
        ),
      );
      row.append(heading, node("p", `${ch.model} · ${ch.base_url}`));
      const actions = node("div", "", "actions");
      actions.append(
        button(ch.enabled ? "停用" : "启用", (b) =>
          action(
            `/v1/admin/channels/${ch.id}/activate`,
            { enabled: !ch.enabled },
            "POST",
            "模型渠道状态已更新",
            b,
          ),
        ),
        button("测试连接", async (b) => {
          b.disabled = true;
          b.textContent = "连接中…";
          try {
            const result = await api(`/v1/admin/channels/${ch.id}/test`, {
              method: "POST",
            });
            if (result.ok) feedback(`${ch.name}：模型连接成功`);
            else
              showError(
                `模型连接失败：${result.status || result.error || "未知响应"}`,
              );
          } catch (e) {
            showError(e.message);
          } finally {
            b.disabled = false;
            b.textContent = "测试连接";
          }
        }),
      );
      if (!ch.enabled)
        actions.append(
          button(
            "删除",
            (b) =>
              action(
                `/v1/admin/channels/${ch.id}`,
                undefined,
                "DELETE",
                "未启用渠道已删除",
                b,
              ),
            "danger",
          ),
        );
      row.append(actions);
      return row;
    }),
  );
  if (!snapshot.channelData.channels.length)
    $("channels").append(empty("尚未配置模型渠道，远端任务使用部署默认模型。"));
}
function renderAudit() {
  $("schedules").replaceChildren(
    ...(snapshot.overview.schedules || []).map((s) => {
      const row = node("div", "", "list-row"),
        heading = node("div", "", "row-heading");
      heading.append(
        node("h3", s.name),
        badge(
          s.enabled ? "online" : "cancelled",
          s.enabled ? "已启用" : "已停用",
        ),
      );
      row.append(
        heading,
        node("p", `${s.cron || "仅手动运行"} · ${s.timezone} · ${s.owner_id}`),
        node("p", `下次执行：${dates(s.next_fire_at)}`),
      );
      if (s.last_error) row.append(node("p", s.last_error, "notice error"));
      return row;
    }),
  );
  if (!snapshot.overview.schedules?.length)
    $("schedules").append(empty("暂无远端定时计划。"));
  $("audit").replaceChildren(
    ...snapshot.overview.audit.map((a) => {
      const row = node("div", "", "audit-entry");
      row.append(
        node("time", dates(a.created_at)),
        node(
          "span",
          `${a.action} · ${a.actor}${a.run_id ? ` · ${a.run_id}` : ""}`,
        ),
      );
      return row;
    }),
  );
  if (!snapshot.overview.audit.length)
    $("audit").append(empty("暂无审计记录。"));
}
async function refresh() {
  if (!token || refreshing) return;
  refreshing = true;
  const before = generation;
  $("refresh").disabled = true;
  if (!snapshot) $("connection").textContent = "正在加载平台状态…";
  try {
    const [overview, list, accountData, channelData, resourceData, policyData] =
      await Promise.all([
        api("/v1/admin/overview"),
        api("/v1/runs"),
        api("/v1/admin/accounts"),
        api("/v1/admin/channels"),
        api("/v1/admin/resources"),
        api("/v1/admin/execution-policy"),
      ]);
    if (before !== generation) return;
    if (connectionError) {
      showError("");
      connectionError = false;
    }
    snapshot = {
      overview,
      list,
      accountData,
      channelData,
      resourceData,
      policyData,
    };
    connected(true);
    $("connection").textContent = "● 控制面已连接";
    $("updated").textContent =
      `更新于 ${new Date().toLocaleTimeString("zh-CN", { hour12: false })}`;
    renderOverview();
    renderRuns();
    renderWorkers();
    renderAccounts();
    renderSettings();
    renderAudit();
    if ($("run-dialog").open && selectedRun) void updateDetail(selectedRun);
  } catch (e) {
    if (before !== generation) return;
    if (e.status === 401 || e.status === 403) {
      connected(false);
      token = "";
      sessionStorage.removeItem("pig.cloud.token");
      $("connection").textContent = "需要重新登录";
      showError("访问令牌无效、已过期或没有管理员权限，请重新连接。");
    } else {
      connectionError = true;
      $("connection").textContent = "连接中断 · 正在自动重试";
      showError(
        `平台数据更新失败：${e.message}。已显示的数据可能不是最新状态。`,
      );
    }
  } finally {
    refreshing = false;
    $("refresh").disabled = false;
  }
}
async function openDetail(id) {
  selectedRun = id;
  detailVersion = "";
  $("detail").replaceChildren(empty("正在加载任务详情与日志…"));
  if (!$("run-dialog").open) $("run-dialog").showModal();
  await updateDetail(id);
}
async function updateDetail(id) {
  if (detailBusy) return;
  detailBusy = true;
  try {
    const [data, logs, attempts] = await Promise.all([
      api(`/v1/runs/${id}`),
      api(`/v1/runs/${id}/eventlog`),
      api(`/v1/runs/${id}/attempts`),
    ]);
    if (selectedRun !== id || !$("run-dialog").open) return;
    const r = data.run || data;
    const version = JSON.stringify([
      id,
      r.updated_at,
      r.state,
      r.model_calls,
      logs.events?.at(-1)?.seq,
      attempts.attempts.length,
    ]);
    if (version === detailVersion) return;
    const container = node("div");
    container.append(
      badge(r.state),
      node("p", r.prompt || "", "detail-prompt"),
    );
    const meta = node("div", "", "detail-meta");
    for (const [key, value] of [
      ["任务 ID", r.id],
      ["Runner", r.worker_id || "尚未分配"],
      ["创建时间", dates(r.created_at)],
      ["更新时间", dates(r.updated_at)],
      ["模型调用", String(r.model_calls ?? 0)],
      ["执行次数", String(attempts.attempts.length)],
    ]) {
      const p = node("p");
      p.append(node("strong", key), document.createTextNode(value || "—"));
      meta.append(p);
    }
    container.append(meta);
    if (r.error) container.append(node("p", r.error, "notice error"));
    const logHeading = node("div", "", "section-heading");
    logHeading.append(
      node("h2", "执行日志 · 最近 200 条"),
      button("下载日志 JSON", () => {
        const url = URL.createObjectURL(
          new Blob([JSON.stringify(logs.events || [], null, 2)], {
            type: "application/json",
          }),
        );
        const link = node("a");
        link.href = url;
        link.download = `${id}-events.json`;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }),
    );
    container.append(logHeading);
    const logList = node("div", "", "log-list");
    for (const entry of logs.events || []) {
      const event = entry.event,
        line = node("div", "", "log-event");
      line.append(node("strong", `#${entry.seq} ${event.type || "event"}\n`));
      const payload = { ...event };
      delete payload.type;
      if (payload.session)
        payload.session = {
          id: payload.session.id,
          status: payload.session.status,
        };
      const text = JSON.stringify(payload, null, 2);
      line.append(
        document.createTextNode(
          text.length > 8000
            ? text.slice(0, 8000) +
                "\n…界面预览已截断，可下载最近 200 条完整事件。"
            : text,
        ),
      );
      logList.append(line);
    }
    if (!logList.childNodes.length)
      logList.append(empty("暂无执行日志；任务开始后会自动更新。"));
    const oldLogs = $("detail").querySelector(".log-list"),
      scrollTop = oldLogs?.scrollTop || 0;
    container.append(logList);
    $("detail").replaceChildren(container);
    logList.scrollTop = scrollTop;
    detailVersion = version;
  } catch (e) {
    detailVersion = "";
    if (selectedRun === id && $("run-dialog").open)
      $("detail").replaceChildren(
        node("p", `详情加载失败：${e.message}。正在自动重试。`, "notice error"),
      );
  } finally {
    detailBusy = false;
  }
}
$("close-detail").onclick = () => $("run-dialog").close();
$("run-dialog").onclose = () => {
  selectedRun = null;
};
$("login-form").onsubmit = async (event) => {
  event.preventDefault();
  if (refreshing) return;
  generation++;
  snapshot = undefined;
  token = $("token").value.trim();
  const submit = event.submitter;
  submit.disabled = true;
  showError("");
  try {
    await api("/v1/admin/overview");
    sessionStorage.setItem("pig.cloud.token", token);
    $("token").value = "";
    await refresh();
  } catch (e) {
    token = "";
    showError(e.message);
  } finally {
    submit.disabled = false;
  }
};
$("logout").onclick = async () => {
  generation++;
  const oldToken = token;
  token = "";
  snapshot = undefined;
  connected(false);
  dirtyForms.clear();
  accountDrafts.clear();
  $("run-dialog").close();
  $("invite-result").textContent = "";
  $("invite-form").querySelector("button").disabled = false;
  $("channel-key").value = "";
  $("feedback").hidden = true;
  showError("");
  $("connection").textContent = "已退出登录";
  sessionStorage.removeItem("pig.cloud.token");
  try {
    await fetch("/v1/logout", {
      method: "POST",
      headers: { Authorization: `Bearer ${oldToken}` },
      signal: AbortSignal.timeout(5000),
    });
  } catch {}
};
$("invite-form").onsubmit = async (event) => {
  event.preventDefault();
  const before = generation;
  const name = $("invite-name").value.trim();
  if (!name) return showError("请输入账号名称");
  const submit = event.submitter;
  submit.disabled = true;
  try {
    const data = await api("/v1/admin/invitations", {
      method: "POST",
      body: JSON.stringify({ name }),
    });
    if (before !== generation) return;
    $("invite-result").textContent =
      `一次性邀请码（24 小时有效）：${data.invite}`;
    $("invite-name").value = "";
    feedback("成员邀请已创建，请私下发送给受邀成员");
  } catch (e) {
    if (before === generation) showError(e.message);
  } finally {
    if (before === generation) submit.disabled = false;
  }
};
$("channel-form").onsubmit = async (event) => {
  event.preventDefault();
  const baseUrl = $("channel-base").value.trim();
  if (new URL(baseUrl).protocol !== "https:")
    return showError("模型渠道必须使用 HTTPS API 地址");
  const body = {
    name: $("channel-name").value.trim(),
    baseUrl,
    model: $("channel-model").value.trim(),
    apiKey: $("channel-key").value.trim(),
  };
  if (Object.values(body).some((v) => !v))
    return showError("请完整填写模型渠道信息");
  if (
    await action(
      "/v1/admin/channels",
      body,
      "POST",
      "模型渠道已加密保存，请启用后用于远端执行",
      event.submitter,
    )
  ) {
    $("channel-key").value = "";
    $("channel-form").reset();
  }
};
$("resource-form").onsubmit = async (event) => {
  event.preventDefault();
  if (
    await action(
      "/v1/admin/resources",
      { profile: $("resource-profile").value },
      "PUT",
      "新任务容器规格已保存，已有任务不受影响",
      event.submitter,
    )
  )
    dirtyForms.delete("resource-form");
};
$("policy-form").onsubmit = async (event) => {
  event.preventDefault();
  const body = Object.fromEntries(
    Object.entries(policyFields).map(([key, id]) => [key, Number($(id).value)]),
  );
  if (
    await action(
      "/v1/admin/execution-policy",
      body,
      "PUT",
      "调度设置已保存，所有控制面实例共享此设置",
      event.submitter,
    )
  )
    dirtyForms.delete("policy-form");
};
for (const id of ["resource-form", "policy-form"])
  $(id).oninput = () => dirtyForms.add(id);
$("show-disabled").onchange = () => {
  if (snapshot) renderAccounts();
};
$("run-search").oninput = () => {
  if (snapshot) renderRuns();
};
$("run-state").onchange = () => {
  if (snapshot) renderRuns();
};
$("refresh").onclick = async () => {
  showError("");
  await refresh();
};
window.addEventListener("hashchange", navigate);
navigate();
connected(false);
void refresh();
setInterval(() => {
  if (!document.hidden) void refresh();
}, 5000);
