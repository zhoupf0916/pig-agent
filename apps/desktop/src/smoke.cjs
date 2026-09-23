const fs = require("node:fs/promises");
const path = require("node:path");
exports.runSmoke = async ({ app, win, origin, userData, accessVault }) => {
  if (process.env.PIG_DESKTOP_APPROVAL_SHOT === "1") {
    await captureApprovalShot({ app, win, userData });
    return;
  }
  if (process.env.PIG_DESKTOP_DEBUG_SHOT === "1") {
    await captureDebugShot({ app, win, userData });
    return;
  }
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
    if (process.env.PIG_DESKTOP_SMOKE_RESTART === "1") {
      await win.webContents.executeJavaScript(`(async()=>{
        const list=await (await fetch('/api/sessions')).json();
        const records=await Promise.all(list.sessions.map(s=>fetch('/api/sessions/'+s.id).then(r=>r.json())));
        if (!records.some(s=>s.engine==='codex' && s.executionTarget==='local')) throw Error('Pinned execution config lost on restart');
        const fresh=await (await fetch('/api/sessions',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).json();
        if(fresh.engine!=='pig') throw Error('New session ignored default engine');
        location.hash='#/sessions/'+fresh.id;
      })()`);
    }
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

async function captureApprovalShot({ app, win, userData }) {
  const fs = require("node:fs/promises");
  const path = require("node:path");
  try {
    const outDir = process.env.PIG_DESKTOP_DEBUG_SHOT_DIR;
    if (!outDir) throw new Error("Shot directory required");
    await fs.mkdir(outDir, { recursive: true });
    win.setContentSize(1288, 768);
    await win.webContents.executeJavaScript(`(async () => {
      localStorage.setItem('pig-agent.desktop-setup', 'complete');
      const created = await (await fetch('/api/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json();
      location.hash = '#/sessions/' + created.id;
    })()`);
    await new Promise((resolve) => {
      win.webContents.once("did-finish-load", resolve);
      win.webContents.reload();
    });
    const result = await win.webContents.executeJavaScript(`(async () => {
      const until = Date.now() + 10000;
      let select;
      while (Date.now() < until) {
        select = document.querySelector('[aria-label="执行位置"]');
        if (select && !select.disabled) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      if (!select) throw new Error('Execution picker missing');
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
      setter.call(select, 'remote');
      select.dispatchEvent(new Event('change', { bubbles: true }));
      let session;
      while (Date.now() < until) {
        const list = await (await fetch('/api/sessions')).json();
        session = await (await fetch('/api/sessions/' + list.sessions[0].id)).json();
        const box = document.querySelector('label input[type="checkbox"]');
        const label = box && box.closest('label') ? box.closest('label').innerText : '';
        if (session.remoteRequireApproval === true && box && box.checked && label.includes('写入与命令需审批')) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      if (session.remoteRequireApproval !== true) throw new Error('Unset remote choice was not stored as approval required');
      const box = [...document.querySelectorAll('label')].find((item) => item.innerText.includes('写入与命令需审批'))?.querySelector('input');
      if (!box || !box.checked) throw new Error('Approval checkbox was not checked for an unset choice');
      box.click();
      while (Date.now() < until) {
        session = await (await fetch('/api/sessions/' + session.id)).json();
        if (session.remoteRequireApproval === false && !box.checked) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      if (session.remoteRequireApproval !== false || box.checked) throw new Error('Explicit opt-out did not stay off');
      box.click();
      while (Date.now() < until) {
        session = await (await fetch('/api/sessions/' + session.id)).json();
        if (session.remoteRequireApproval === true && box.checked) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      if (session.remoteRequireApproval !== true) throw new Error('Turning approval back on before a run did not persist');
      return { id: session.id, remoteRequireApproval: session.remoteRequireApproval };
    })()`);
    const desktop = await win.capturePage();
    await fs.writeFile(path.join(outDir, "approval-remote-desktop.png"), desktop.toPNG());
    win.setContentSize(390, 844);
    await new Promise((resolve) => setTimeout(resolve, 400));
    const narrow = await win.capturePage();
    await fs.writeFile(path.join(outDir, "approval-remote-narrow.png"), narrow.toPNG());
    await fs.writeFile(path.join(userData, "smoke.json"), JSON.stringify({ ok: true, approval: result }));
    app.quit();
  } catch (error) {
    await fs.writeFile(path.join(userData, "smoke.json"), JSON.stringify({ ok: false, error: error.message }));
    app.quit();
  }
}

async function captureDebugShot({ app, win, userData }) {
  const fs = require("node:fs/promises");
  const path = require("node:path");
  try {
    const mockURL = process.env.PIG_DESKTOP_SMOKE_MODEL_URL;
    if (!mockURL || new URL(mockURL).hostname !== "127.0.0.1") throw new Error("Local mock required");
    const outDir = process.env.PIG_DESKTOP_DEBUG_SHOT_DIR;
    if (!outDir) throw new Error("Shot directory required");
    await fs.mkdir(outDir, { recursive: true });
    await win.webContents.executeJavaScript(`(async () => {
      const save = await fetch('/api/settings', { method: 'PUT', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ runtime: 'pig', llmBaseUrl: ${JSON.stringify(mockURL)}, llmApiKey: 'desktop-smoke-fake-key', llmModel: 'mock' }) });
      if (!save.ok) throw new Error(await save.text());
      const created = await (await fetch('/api/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json();
      localStorage.setItem('pig-agent.desktop-setup', 'complete');
      location.hash = '#/sessions/' + created.id;
    })()`);
    await new Promise((resolve) => { win.webContents.once("did-finish-load", resolve); win.webContents.reload(); });
    win.setContentSize(1288, 768);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const trace = await win.webContents.executeJavaScript(`(async () => { try {
      const until = Date.now() + 15000;
      let input;
      while (Date.now() < until) { input = document.querySelector('textarea'); if (input && !input.disabled) break; await new Promise(r => setTimeout(r, 50)); }
      if (!input || input.disabled) throw new Error('Composer unavailable');
      const list = await (await fetch('/api/sessions')).json();
      const session = list.sessions[0];
      await fetch('/api/sessions/' + session.id + '/debug', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: true }) });
      const message = '请读取 README';
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, message);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise(r => setTimeout(r, 100));
      const send = document.querySelector('button[aria-label="发送"]');
      if (!send || send.disabled) throw new Error('Send button unavailable');
      send.click();
      let view;
      while (Date.now() < until) {
        const task = await (await fetch('/api/sessions/' + session.id)).json();
        view = await (await fetch('/api/sessions/' + session.id + '/debug')).json();
        if (task.status === 'idle' && view.spans.some(span => span.kind === 'model')) break;
        await new Promise(r => setTimeout(r, 150));
      }
      if (!view.spans.some(span => span.kind === 'model')) throw new Error('Model span missing');
      document.querySelector('[aria-label="文件与产物"]').click();
      await new Promise(r => setTimeout(r, 200));
      const tab = [...document.querySelectorAll('button')].find(button => button.textContent.trim() === '开发者');
      if (!tab) throw new Error('Developer tab missing');
      tab.click();
      await new Promise(r => setTimeout(r, 400));
      const modelButtons = [...document.querySelectorAll('[aria-label="开发者"] button')].filter((button) => button.textContent.includes('model ·'));
      const modelButton = modelButtons.at(-1);
      if (!modelButton) throw new Error('Model row missing');
      modelButton.click();
      await new Promise(r => setTimeout(r, 200));
      const section = (name) => [...document.querySelectorAll('[aria-label="调用详情"] details')].find((item) => item.querySelector('summary')?.textContent.includes(name));
      const overview = section('概览');
      const request = section('请求');
      const response = section('响应');
      const environment = section('执行环境');
      if (!overview?.open || !response?.open) throw new Error('Summary sections were not open');
      if (environment?.open) throw new Error('Environment section should start collapsed');
      if (request?.open) throw new Error('Request section should start collapsed');
      const tools = request?.querySelector('details');
      if (!tools || tools.open) throw new Error('Tool schema should start collapsed');
      if (!overview.innerText.includes('TTFT') || !overview.innerText.includes('方法')) throw new Error('Overview is missing timings');
      const paneEl = document.querySelector('[aria-label="调用详情"]');
      paneEl.scrollTop += response.getBoundingClientRect().top - paneEl.getBoundingClientRect().top;
      const pane = paneEl.getBoundingClientRect();
      const responseBox = response.getBoundingClientRect();
      if (responseBox.bottom < pane.top || responseBox.top > pane.bottom) throw new Error('Response is not reachable in the detail pane');
      const callList = document.querySelector('[aria-label="调用列表"]');
      const row = callList.querySelector('button');
      const rowBox = row.getBoundingClientRect();
      const listBox = callList.getBoundingClientRect();
      if (rowBox.top < listBox.top - 1 || rowBox.bottom > listBox.bottom + 1) throw new Error('Call row is outside the list');
      if (callList.querySelector('[aria-label="调用时间线"]')) throw new Error('Timeline is inside the call list');
      const timeline = document.querySelector('[aria-label="调用时间线"]');
      if (!timeline || timeline.open) throw new Error('Timeline should start collapsed');
      if (document.body.innerText.includes('审阅并导入到本机')) throw new Error('Import footer is visible on the developer tab');
      const panel = document.querySelector('[aria-label="开发者"]');
      if (panel && panel.scrollWidth > panel.clientWidth + 8) throw new Error('Developer panel overflows its width');
      if (!document.body.innerText.includes('开发者') || document.body.innerText.includes('让任务从这里开始')) throw new Error('Developer tab was not visible');
      const frame = document.querySelector('[aria-label="任务成果检查器"]').getBoundingClientRect();
      const calls = document.querySelector('[aria-label="调用列表"]').getBoundingClientRect();
      if (frame.width < 640) throw new Error('Developer inspector is still narrow: ' + Math.round(frame.width));
      if (calls.height < 100) throw new Error('Call list has no visible height: ' + Math.round(calls.height));
      const expand = document.querySelector('[aria-label="展开开发者"]');
      if (!expand) throw new Error('Expand control missing');
      expand.click();
      await new Promise((r) => setTimeout(r, 200));
      const expanded = document.querySelector('[aria-label="任务成果检查器"]').getBoundingClientRect();
      if (expanded.width < frame.width + 40) throw new Error('Expand did not widen the inspector');
      document.querySelector('[aria-label="收回开发者"]').click();
      await new Promise((r) => setTimeout(r, 150));
      return view;
    } catch (err) { throw new Error(err && err.stack ? err.stack : String(err)); } })()`);
    const serialized = JSON.stringify(trace);
    if (serialized.includes("desktop-smoke-fake-key") || serialized.includes("sk-")) throw new Error("Secret leaked into debug trace");
    await fs.writeFile(path.join(userData, "debug-trace.json"), JSON.stringify(trace, null, 2));
    const desktop = await win.capturePage();
    await fs.writeFile(path.join(outDir, "developer-desktop.png"), desktop.toPNG());
    win.setContentSize(390, 844);
    await new Promise((resolve) => setTimeout(resolve, 400));
    await win.webContents.executeJavaScript(`(() => {
      const calls = document.querySelector('[aria-label="调用列表"]').getBoundingClientRect();
      const frame = document.querySelector('[aria-label="任务成果检查器"]').getBoundingClientRect();
      if (calls.height < 80) throw new Error('Narrow call list hidden ' + Math.round(calls.height));
      if (frame.width < 320) throw new Error('Narrow inspector did not fill the window ' + Math.round(frame.width));
    })()`);
    const narrow = await win.capturePage();
    await fs.writeFile(path.join(outDir, "developer-narrow.png"), narrow.toPNG());
    win.setContentSize(1288, 768);
    await win.webContents.executeJavaScript(`(async () => {
      const list = await (await fetch('/api/sessions')).json();
      const session = list.sessions[0];
      const patched = await fetch('/api/sessions/' + session.id, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ executionTarget: 'remote', engine: 'pig' }),
      });
      if (!patched.ok) throw new Error(await patched.text());
    })()`);
    await new Promise((resolve) => {
      win.webContents.once("did-finish-load", resolve);
      win.webContents.reload();
    });
    await win.webContents.executeJavaScript(`(async () => {
      const until = Date.now() + 10000;
      let box;
      while (Date.now() < until) {
        const inspector = document.querySelector('[aria-label="文件与产物"]');
        if (!inspector || inspector.getAttribute('aria-expanded') !== 'true') {
          if (inspector) inspector.click();
          await new Promise((r) => setTimeout(r, 200));
          continue;
        }
        const tab = [...document.querySelectorAll('button')].find((button) => button.textContent.trim() === '开发者');
        if (tab && tab.getAttribute('aria-pressed') !== 'true') tab.click();
        box = document.querySelector('[aria-label="下次远端运行记录正文"]');
        if (box) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      if (!box) throw new Error('Remote debug content switch missing expanded=' + document.querySelector('[aria-label="文件与产物"]')?.getAttribute('aria-expanded') + ' text=' + document.body.innerText.slice(0, 240).replace(/\\s+/g, ' '));
      const frame = document.querySelector('[aria-label="任务成果检查器"]').getBoundingClientRect();
      const calls = document.querySelector('[aria-label="调用列表"]');
      if (!calls || calls.getBoundingClientRect().height < 80) throw new Error('Remote call list is not visible');
      if (frame.width < 640) throw new Error('Remote developer inspector is narrow ' + Math.round(frame.width));
      if (box.checked) throw new Error('Remote debug content defaulted on');
      box.click();
      const list = await (await fetch('/api/sessions')).json();
      const id = list.sessions[0].id;
      let saved;
      while (Date.now() < until) {
        saved = await (await fetch('/api/sessions/' + id)).json();
        if (saved.remoteDebugContent === true) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      if (saved.remoteDebugContent !== true) throw new Error('Remote debug content was not saved for this session');
      const created = await (await fetch('/api/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json();
      if (created.remoteDebugContent === true) throw new Error('New session inherited remote debug content');
    })()`);
    const remoteDesktop = await win.capturePage();
    await fs.writeFile(path.join(outDir, "developer-remote-desktop.png"), remoteDesktop.toPNG());
    win.setContentSize(390, 844);
    await new Promise((resolve) => setTimeout(resolve, 400));
    const remoteNarrow = await win.capturePage();
    await fs.writeFile(path.join(outDir, "developer-remote-narrow.png"), remoteNarrow.toPNG());
    await fs.writeFile(path.join(userData, "smoke.json"), JSON.stringify({ ok: true, spans: trace.spans.length }));
    app.quit();
  } catch (error) {
    await fs.writeFile(path.join(userData, "smoke.json"), JSON.stringify({ ok: false, error: error.message }));
    app.quit();
  }
}
