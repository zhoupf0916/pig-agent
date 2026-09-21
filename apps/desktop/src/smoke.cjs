const fs = require("node:fs/promises");
const path = require("node:path");
exports.runSmoke = async ({ app, win, origin, userData, accessVault }) => {
  // Dedicated integration test mode uses isolated data and a local mock model only.

  try {
    const unauthorized = await fetch(origin + "/api/settings");
    const state = await win.webContents.executeJavaScript(
      `(async () => ({ settings: await (await fetch('/api/settings')).json(), bridge: typeof window.pigDesktop?.chooseWorkspace, node: typeof window.require, info: await window.pigDesktop.info(), persisted: localStorage.getItem('pig-agent.smoke-persistence') }))()`,
    );
    if (
      unauthorized.status !== 401 ||
      state.bridge !== "function" ||
      state.node !== "undefined" ||
      !state.info.version ||
      state.settings.llmApiKey
    )
      throw new Error("Desktop isolation failed");
    if (
      process.env.PIG_DESKTOP_SMOKE_RESTART === "1" &&
      state.persisted !== "yes"
    )
      throw new Error("Draft storage did not survive restart");
    const mockURL = process.env.PIG_DESKTOP_SMOKE_MODEL_URL;
    if (!mockURL || new URL(mockURL).hostname !== "127.0.0.1")
      throw new Error("Local mock required");
    const saved = await win.webContents.executeJavaScript(`(async () => {
        const save = await fetch('/api/settings', { method: 'PUT', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ llmBaseUrl: ${JSON.stringify(mockURL)}, llmApiKey: 'desktop-smoke-fake-key', llmModel: 'mock' }) });
        const settings = await save.json();
        const test = await fetch('/api/desktop/test-connection', { method: 'POST' });
        localStorage.setItem('pig-agent.smoke-persistence', 'yes');
        return { redacted: settings.llmApiKey === '', configured: settings.llmApiKeyConfigured, testStatus: test.status };
      })()`);
    const chat = await win.webContents.executeJavaScript(`(async () => {
      const session = await (await fetch('/api/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json();
      const response = await fetch('/api/sessions/' + session.id + '/messages', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: 'Reply OK', clientMessageId: crypto.randomUUID() }) });
      const events = await response.text();
      const saved = await (await fetch('/api/sessions/' + session.id)).json();
      return { streamed: events.includes('event: token') && events.includes('event: done'), users: saved.messages.filter(m => m.role === 'user').length, answer: saved.messages.findLast(m => m.role === 'assistant')?.content };
    })()`);
    if (!chat.streamed || chat.users !== 1 || chat.answer !== "OK")
      throw new Error("Chat/SSE proxy failed");
    const disk = await fs.readFile(
      path.join(userData, "data/settings.json"),
      "utf8",
    );
    const vault = await fs.readFile(path.join(userData, "credentials.bin"));
    if (
      !saved.redacted ||
      !saved.configured ||
      saved.testStatus !== 200 ||
      disk.includes("desktop-smoke-fake-key") ||
      vault.includes(Buffer.from("desktop-smoke-fake-key"))
    )
      throw new Error("Credential isolation failed");
    const decrypted = await accessVault("read");
    if (decrypted.llmApiKey !== "desktop-smoke-fake-key")
      throw new Error("Vault round-trip failed");
    await fs.writeFile(
      path.join(userData, "smoke.json"),
      JSON.stringify({
        ok: true,
        unauthorizedStatus: unauthorized.status,
        bridge: state.bridge,
        node: state.node,
        workspace: state.settings.workspaceRoot,
        encryptedCredentials: true,
        modelConnection: true,
        streamingChat: true,
        origin,
        persisted: state.persisted,
      }),
    );
    app.quit();
  } catch {
    await fs.writeFile(
      path.join(userData, "smoke.json"),
      JSON.stringify({ ok: false }),
    );
    app.quit();
  }
};
