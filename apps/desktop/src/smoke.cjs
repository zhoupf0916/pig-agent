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
        const save = await fetch('/api/settings', { method: 'PUT', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ runtime: 'pig', llmBaseUrl: ${JSON.stringify(mockURL)}, llmApiKey: 'desktop-smoke-fake-key', llmModel: 'mock' }) });
        const settings = await save.json();
        const test = await fetch('/api/settings/test-connection', { method: 'POST' });
        localStorage.setItem('pig-agent.smoke-persistence', 'yes');
        return { redacted: settings.llmApiKey === '', configured: settings.llmApiKeyConfigured, testStatus: test.status };
      })()`);
    await win.webContents.executeJavaScript("localStorage.setItem('pig-agent.desktop-setup', 'complete')");
    await new Promise(resolve => { win.webContents.once('did-finish-load', resolve); win.webContents.reload(); });
    const uiChat = await win.webContents.executeJavaScript(`(async () => {
      const until = Date.now() + 8000;
      let input;
      while (Date.now() < until) { input = document.querySelector('textarea'); if (input && !input.disabled) break; await new Promise(r => setTimeout(r, 50)); }
      if (!input || input.disabled) throw new Error('Composer unavailable on empty workbench');
      const message = 'UI_SMOKE_' + crypto.randomUUID();
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, message);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise(r => setTimeout(r, 100));
      const send = document.querySelector('button[aria-label="发送"]');
      if (!send || send.disabled) throw new Error('Send button unavailable');
      send.click(); send.click();
      while (Date.now() < until) {
        const list = await (await fetch('/api/sessions')).json();
        for (const entry of list.sessions) {
          const task = await (await fetch('/api/sessions/' + entry.id)).json();
          const count = task.messages.filter(m => m.role === 'user' && m.content === message).length;
          if (count && task.status === 'idle' && task.messages.at(-1)?.content === 'OK') return count === 1;
        }
        await new Promise(r => setTimeout(r, 100));
      }
      throw new Error('UI send did not complete');
    })()`);
    if (!uiChat) throw new Error('Duplicate UI message');
    const chat = await win.webContents.executeJavaScript(`(async () => {
      const session = await (await fetch('/api/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json();
      const response = await fetch('/api/sessions/' + session.id + '/messages', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: 'Reply OK', clientMessageId: crypto.randomUUID() }) });
      const events = await response.text();
      const saved = await (await fetch('/api/sessions/' + session.id)).json();
      return { streamed: events.includes('event: token') && events.includes('event: done'), users: saved.messages.filter(m => m.role === 'user').length, answer: saved.messages.findLast(m => m.role === 'assistant')?.content };
    })()`);
    if (!chat.streamed || chat.users !== 1 || chat.answer !== "OK")
      throw new Error("Chat/SSE proxy failed");
    const codex = await win.webContents.executeJavaScript(`(async () => {
      await fetch('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ runtime: 'codex', codexBaseUrl: ${JSON.stringify(mockURL)}, codexBinaryPath: ${JSON.stringify(process.env.PIG_DESKTOP_SMOKE_CODEX_BIN)}, codexModel: 'deepseek-flash' }) });
      const copy = await fetch('/api/settings/codex/use-pig-key', { method: 'POST' });
      const visible = await copy.json();
      const test = await fetch('/api/settings/test-connection', { method: 'POST' });
      if (!test.ok) return { ok: false, error: await test.text() };
      const task = await (await fetch('/api/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json();
      await (await fetch('/api/sessions/' + task.id + '/messages', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: 'Reply CODEX_OK, no tools.' }) })).text();
      const final = await (await fetch('/api/sessions/' + task.id)).json();
      return { ok: copy.ok && visible.codexApiKey === '' && visible.codexApiKeyConfigured && final.messages.at(-1)?.content === 'CODEX_OK' && !final.lastError };
    })()`);
    if (!codex.ok) throw new Error('Desktop Codex failed: ' + (codex.error || 'chat/key'));
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
    if (decrypted.llmApiKey !== "desktop-smoke-fake-key" || decrypted.codexApiKey !== "desktop-smoke-fake-key")
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
        uiAutoCreateAndDedupe: true,
        nativeCodex: true,
        origin,
        persisted: state.persisted,
      }),
    );
    app.quit();
  } catch (error) {
    await fs.writeFile(
      path.join(userData, "smoke.json"),
      JSON.stringify({ ok: false, error: error.message }),
    );
    app.quit();
  }
};
