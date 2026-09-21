const {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  safeStorage,
  shell,
  utilityProcess,
  protocol,
} = require("electron");
const fs = require("node:fs/promises");
const path = require("node:path");
const { randomBytes } = require("node:crypto");

app.setName("Pig Agent");
if (process.env.PIG_DESKTOP_USER_DATA)
  app.setPath("userData", path.resolve(process.env.PIG_DESKTOP_USER_DATA));
protocol.registerSchemesAsPrivileged([
  {
    scheme: "pig",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      corsEnabled: true,
    },
  },
]);
const isAppURL = (value) => {
  const url = new URL(value);
  return url.protocol === "pig:" && url.host === "app";
};
let win,
  backend,
  origin,
  quitting = false;
const userData = app.getPath("userData");
const runtime = app.isPackaged
  ? path.join(process.resourcesPath, "runtime")
  : path.join(__dirname, "../../../desktop-dist/runtime");
const accessVault = require("./vault.cjs").createVault(userData, safeStorage);
function validateSender(event) {
  if (
    event.sender !== win?.webContents ||
    event.senderFrame !== win.webContents.mainFrame ||
    !isAppURL(event.senderFrame.url)
  )
    throw new Error("Unauthorized IPC");
}
async function exportDiagnostics() {
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    defaultPath: "pig-agent-diagnostics.json",
    filters: [{ name: "JSON", extensions: ["json"] }],
  });
  if (!canceled && filePath)
    await fs.writeFile(
      filePath,
      JSON.stringify(
        {
          appVersion: app.getVersion(),
          electron: process.versions.electron,
          node: process.versions.node,
          platform: process.platform,
          arch: process.arch,
          backendRunning: !!backend,
          generatedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
}
async function start() {
  await fs.mkdir(path.join(userData, "workspace"), { recursive: true });
  const token = randomBytes(32).toString("hex");
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !/^(PIG_|LLM_|DEEPSEEK_|OPENAI_|CODEX_|CLOUD_|DATA_DIR$|WORKSPACE_ROOT$|PORT$|WEB_ORIGIN$|NODE_OPTIONS$|ELECTRON_RUN_AS_NODE$)/.test(
          key,
        ),
    ),
  );
  Object.assign(env, {
    PIG_DESKTOP: "1",
    PIG_DESKTOP_TOKEN: token,
    PIG_APP_ROOT: runtime,
    DATA_DIR: path.join(userData, "data"),
    WORKSPACE_ROOT: path.join(userData, "workspace"),
    PATH: `${env.PATH || ""}:/opt/homebrew/bin:/usr/local/bin:${app.getPath("home")}/.docker/bin`,
  });
  const child = utilityProcess.fork(path.join(runtime, "server.mjs"), [], {
    env,
    cwd: runtime,
    serviceName: "Pig Agent Backend",
    stdio: "ignore",
  });
  backend = child;
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("本地服务启动超时")),
      20000,
    );
    child.on("message", (message) => {
      if (message.type === "ready") {
        clearTimeout(timer);
        resolve(message.port);
      }
      if (message.type === "secret") {
        const request = accessVault(message.method, message.value);
        request.then(
          (value) =>
            child.postMessage({ type: "secret-result", id: message.id, value }),
          () =>
            child.postMessage({
              type: "secret-result",
              id: message.id,
              error: true,
            }),
        );
      }
    });
    child.once("exit", () => {
      clearTimeout(timer);
      backend = undefined;
      reject(new Error("本地服务退出"));
      if (!quitting && win) {
        dialog.showErrorBox(
          "本地服务已停止",
          "请退出并重新打开 Pig Agent。会话保存在本机。",
        );
        app.quit();
      }
    });
  });
  origin = `http://127.0.0.1:${port}`;
  win = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 960,
    minHeight: 680,
    title: "Pig Agent",
    backgroundColor: "#f6f7f3",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      partition: "persist:pig-agent",
    },
  });
  const session = win.webContents.session;
  session.setPermissionRequestHandler((_wc, _permission, callback) =>
    callback(false),
  );
  session.setPermissionCheckHandler(() => false);
  session.protocol.handle("pig", async (request) => {
    if (!isAppURL(request.url))
      return new Response("Forbidden", { status: 403 });
    const url = new URL(request.url);
    const headers = new Headers(request.headers);
    headers.set("Authorization", `Bearer ${token}`);
    headers.delete("Origin");
    headers.delete("Host");
    if (quitting)
      return new Response("Application is closing", { status: 503 });
    try {
      const response = await fetch(origin + url.pathname + url.search, {
        method: request.method,
        headers,
        body: ["GET", "HEAD"].includes(request.method)
          ? undefined
          : await request.arrayBuffer(),
        redirect: "manual",
        signal: request.signal,
      });
      return new Response(response.body, {
        status: response.status,
        headers: response.headers,
      });
    } catch {
      return Response.json(
        { error: "本地服务不可用，请重新打开应用。" },
        { status: 503 },
      );
    }
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url) && new URL(url).origin !== origin)
      void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (!isAppURL(url)) event.preventDefault();
  });
  win.webContents.on("will-attach-webview", (event) => event.preventDefault());
  await win.loadURL("pig://app");
  win.show();
  if (process.env.PIG_DESKTOP_SMOKE === "1")
    await require("./smoke.cjs").runSmoke({
      app,
      win,
      origin,
      userData,
      accessVault,
    });
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  app.whenReady().then(async () => {
    ipcMain.handle("desktop:choose-workspace", async (event) => {
      validateSender(event);
      const result = await dialog.showOpenDialog(win, {
        properties: ["openDirectory", "createDirectory"],
      });
      return result.canceled ? null : result.filePaths[0];
    });
    ipcMain.handle("desktop:info", (event) => {
      validateSender(event);
      return { version: app.getVersion(), platform: process.platform };
    });
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        {
          label: "Pig Agent",
          submenu: [{ role: "about" }, { type: "separator" }, { role: "quit" }],
        },
        { role: "editMenu" },
        { role: "viewMenu" },
        { role: "windowMenu" },
        {
          label: "帮助",
          submenu: [
            {
              label: "使用说明 / 新版本",
              click: () =>
                shell.openExternal(
                  "https://github.com/zhoupf0916/pig-agent#readme",
                ),
            },
            {
              label: "打开应用数据目录",
              click: () => shell.openPath(userData),
            },
            {
              label: "导出诊断信息（不含密钥与会话）",
              click: () =>
                exportDiagnostics().catch(() =>
                  dialog.showErrorBox("导出失败", "无法写入所选文件。"),
                ),
            },
          ],
        },
      ]),
    );
    try {
      await start();
    } catch (error) {
      dialog.showErrorBox("Pig Agent 启动失败", error.message);
      app.quit();
    }
  });
  app.on("window-all-closed", () => app.quit());
  app.on("before-quit", (event) => {
    if (quitting || !backend) return;
    event.preventDefault();
    quitting = true;
    const child = backend;
    child.once("exit", () => app.quit());
    child.postMessage({ type: "shutdown" });
    setTimeout(() => {
      child.kill();
      app.quit();
    }, 4000).unref();
  });
}
