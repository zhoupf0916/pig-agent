const { execFile, spawn } = require("node:child_process");
const fs = require("node:fs/promises");
const path = require("node:path");
const { promisify } = require("node:util");
const { createHash, randomUUID } = require("node:crypto");
const source = require("./computer-native.cjs");
function validateAction(input) {
  if (
    !input ||
    !["observe", "click", "type", "key", "scroll"].includes(input.action)
  )
    throw new Error("不支持的电脑操作");
  if (
    input.appName !== undefined &&
    (typeof input.appName !== "string" ||
      !input.appName.trim() ||
      input.appName.length > 100)
  )
    throw new Error("应用名称无效");
  if (
    input.action !== "observe" &&
    (typeof input.observationId !== "string" ||
      input.observationId.length > 100)
  )
    throw new Error("请提供最近观察返回的 observationId");
  if (
    input.action === "click" &&
    ![input.x, input.y].every(
      (v) => Number.isFinite(v) && v >= -20000 && v <= 20000,
    )
  )
    throw new Error("坐标无效");
  if (
    input.action === "type" &&
    (typeof input.text !== "string" ||
      !input.text.length ||
      input.text.length > 2000)
  )
    throw new Error("输入文本长度必须为 1–2000");
  if (
    input.action === "key" &&
    ![
      "enter",
      "tab",
      "escape",
      "backspace",
      "up",
      "down",
      "left",
      "right",
    ].includes(input.key)
  )
    throw new Error("不支持的按键");
  if (
    input.action === "scroll" &&
    (!Number.isInteger(input.delta) || Math.abs(input.delta) > 2000)
  )
    throw new Error("滚动距离无效");
  return Object.fromEntries(
    Object.entries(input).filter(([k]) =>
      [
        "action",
        "x",
        "y",
        "text",
        "key",
        "delta",
        "observationId",
        "appName",
      ].includes(k),
    ),
  );
}
function createComputer({
  app,
  dialog,
  systemPreferences,
  desktopCapturer,
  getWindow,
}) {
  let enabled = false,
    busy = false,
    generation = 0,
    lastPid = 0,
    observationId,
    expiresAt = 0,
    lastApp,
    currentRequest,
    nativeChild;
  const bundled = app.isPackaged
    ? path.join(process.resourcesPath, "runtime", "computer-helper")
    : path.join(__dirname, "../../../desktop-dist/runtime/computer-helper");
  let helper = path.join(
    app.getPath("userData"),
    "native",
    `computer-${createHash("sha256").update(source).digest("hex").slice(0, 12)}`,
  );
  let compiling;
  async function ensure() {
    try {
      await fs.access(bundled);
      helper = bundled;
      return;
    } catch {}
    if (app.isPackaged)
      throw new Error("客户端原生组件缺失，请重新安装完整版本");
    try {
      await fs.access(helper);
      return;
    } catch {}
    if (!compiling)
      compiling = (async () => {
        await fs.mkdir(path.dirname(helper), { recursive: true, mode: 0o700 });
        const file = helper + ".swift";
        await fs.writeFile(file, source, { mode: 0o600 });
        await promisify(execFile)(
          "/usr/bin/xcrun",
          ["swiftc", file, "-o", helper],
          { timeout: 120000, maxBuffer: 1024 * 1024 },
        );
        await fs.chmod(helper, 0o700);
      })().catch((e) => {
        compiling = null;
        throw new Error(
          "本机原生组件不可用；需要安装 Xcode Command Line Tools。" +
            e.message.slice(0, 150),
        );
      });
    await compiling;
  }
  async function native(input, valid = () => true) {
    await ensure();
    if (!valid()) throw new Error("电脑操作已取消");
    return new Promise((resolve, reject) => {
      const child = spawn(helper, [], { stdio: ["pipe", "pipe", "pipe"] });
      nativeChild = child;
      let out = "";
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error("原生操作超时"));
      }, 10000);
      child.stdout.on("data", (d) => {
        out += d;
        if (out.length > 200000) child.kill();
      });
      child.on("error", reject);
      child.on("exit", () => {
        if (nativeChild === child) nativeChild = undefined;
        clearTimeout(timer);
        try {
          resolve(JSON.parse(out));
        } catch {
          reject(new Error("原生组件响应无效"));
        }
      });
      child.stdin.end(JSON.stringify(input));
    });
  }
  const status = () => ({
    available: process.platform === "darwin",
    enabled,
    accessibility:
      process.platform === "darwin" &&
      systemPreferences.isTrustedAccessibilityClient(false),
    screen:
      process.platform === "darwin"
        ? systemPreferences.getMediaAccessStatus("screen")
        : "unavailable",
    busy,
  });
  return async function request(method, input = {}) {
    if (method === "cancel") {
      if (currentRequest === input.requestId) {
        generation++;
        nativeChild?.kill();
      }
      return { cancelled: true };
    }
    if (method === "revoke") {
      enabled = false;
      generation++;
      nativeChild?.kill();
      lastPid = 0;
      observationId = undefined;
      return status();
    }
    if (process.platform !== "darwin")
      return {
        available: false,
        enabled: false,
        error: "电脑操作目前仅支持 macOS 客户端",
      };
    if (method === "status") return status();
    if (busy) throw new Error("另一个电脑操作正在等待确认或执行");
    busy = true;
    currentRequest = input.requestId;
    const epoch = generation;
    const valid = () => epoch === generation;
    try {
      if (method === "enable") {
        const result = await dialog.showMessageBox(getWindow(), {
          type: "warning",
          title: "启用本机电脑操作",
          message: "允许 Agent 请求查看屏幕和操作应用？",
          detail:
            "仅当前客户端进程有效。每次查看、点击或输入仍需你确认。屏幕与应用文本可能包含个人信息，并会作为模型上下文。可随时在设置中停用。",
          buttons: ["取消", "启用"],
          defaultId: 0,
          cancelId: 0,
        });
        enabled = valid() && result.response === 1;
        return { ...status(), busy: false };
      }
      if (method !== "execute" || !enabled)
        throw new Error("请先在客户端设置中启用电脑操作");
      const action = validateAction(input);
      if (
        action.action !== "observe" &&
        (action.observationId !== observationId || Date.now() > expiresAt)
      )
        throw new Error("观察已过期，请重新观察目标应用");
      const before = await native(
        { action: "status", appName: action.appName },
        valid,
      );
      if (before.error) throw new Error(before.error);
      if (
        action.action === "observe" &&
        /^(Pig Agent|Electron|System Settings|System Preferences|SecurityAgent|loginwindow|系统设置|系统偏好设置)$/i.test(
          before.app,
        )
      )
        throw new Error(
          "不能操作客户端自身或系统权限窗口。请指定目标应用 appName（例如 TextEdit），或先切换到目标应用。",
        );
      if (!before.accessibility)
        throw new Error(
          "缺少 macOS 辅助功能权限，请在系统设置中授权 Pig Agent / Electron 后重试",
        );
      // Retain the observed target while Pig Agent's confirmation window takes focus.
      const pid = action.action === "observe" ? before.pid : lastPid;
      if (!pid) throw new Error("请先观察目标应用，再请求操作");
      const confirmed = await dialog.showMessageBox(getWindow(), {
        type: "warning",
        title: "确认电脑操作",
        message: `Agent 请求：${action.action}`,
        detail: `目标应用：${action.action === "observe" ? before.app : lastApp}（${pid}）\n${action.action === "type" ? action.text : JSON.stringify(action)}\n确认前检查目标应用。取消不会执行。`,
        buttons: ["取消", "允许本次"],
        defaultId: 0,
        cancelId: 0,
      });
      if (confirmed.response !== 1 || epoch !== generation || !enabled)
        throw new Error("用户取消了电脑操作");
      if (action.action !== "observe" && Date.now() > expiresAt)
        throw new Error("等待确认期间观察已过期，请重新观察");
      const result = await native({ ...action, pid }, valid);
      if (result.error) throw new Error(result.error);
      if (!valid() || !enabled) throw new Error("电脑操作已取消");
      if (action.action === "observe") {
        lastPid = pid;
        lastApp = before.app;
        observationId = randomUUID();
        expiresAt = Date.now() + 60000;
        result.observationId = observationId;
        result.expiresAt = expiresAt;
        if (systemPreferences.getMediaAccessStatus("screen") === "granted") {
          const screens = await desktopCapturer.getSources({
            types: ["screen"],
            thumbnailSize: { width: 1280, height: 800 },
          });
          result.screenshot = screens[0]?.thumbnail.toDataURL();
        } else
          result.screenPermission =
            "需要在 macOS 系统设置中授权屏幕录制才能预览截图";
      }
      if (!valid() || !enabled) throw new Error("电脑操作已取消");
      if (action.action !== "observe") observationId = undefined;
      return result;
    } finally {
      busy = false;
      currentRequest = undefined;
    }
  };
}
module.exports = { createComputer, validateAction };
