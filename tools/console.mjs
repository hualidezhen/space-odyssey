// 打开一个页面并把控制台/异常全部打印出来（无头 Chrome + CDP）
// node tools/console.mjs "<url>" [等待毫秒]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const url = process.argv[2] || 'http://127.0.0.1:5183/?shot=1';
const waitMs = Number(process.argv[3] || 6000);
const chrome = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const port = 9700 + Math.floor(Math.random() * 200);
const udd = path.join(process.env.TEMP || '.', 'dsh-con-' + Math.random().toString(36).slice(2, 9));
const proc = spawn(chrome, [
  '--headless=new', '--no-sandbox', '--disable-gpu-sandbox', '--hide-scrollbars',
  '--window-size=1600,900', '--enable-unsafe-swiftshader', '--use-angle=swiftshader',
  `--remote-debugging-port=${port}`, `--user-data-dir=${udd}`, 'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws, id = 1;
const p = new Map();
const send = (method, params = {}) => {
  const i = id++;
  ws.send(JSON.stringify({ id: i, method, params }));
  return new Promise((res) => p.set(i, res));
};

try {
  let targets = null;
  for (let i = 0; i < 60 && !targets; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/json/list`); if (r.ok) targets = await r.json(); } catch {}
    if (!targets) await sleep(200);
  }
  const page = targets.find((t) => t.type === 'page');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && p.has(m.id)) { p.get(m.id)(m.result); p.delete(m.id); return; }
    if (m.method === 'Runtime.consoleAPICalled') {
      const t = (m.params.args || []).map((a) => a.value ?? a.description ?? a.type).join(' ');
      console.log(`[${m.params.type}] ${String(t).slice(0, 400)}`);
    }
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      console.log('[exception] ' + (d.exception?.description || d.text).slice(0, 800));
    }
    if (m.method === 'Log.entryAdded') {
      const e = m.params.entry;
      console.log(`[${e.level}] ${e.text.slice(0, 300)}` + (e.url ? '  @' + e.url.split('/').pop() : ''));
    }
  };
  await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable');
  await send('Page.navigate', { url });
  await sleep(waitMs);
  const st = await send('Runtime.evaluate', { expression: 'JSON.stringify({ready:!!window.__READY,boot:document.getElementById("boot")?.className||""})', returnByValue: true });
  console.log('[state] ' + st.result?.value);
} catch (e) {
  console.error('probe 失败: ' + e.message);
} finally {
  try { ws?.close(); } catch {}
  try { proc.kill(); } catch {}
  await sleep(200);
  try { fs.rmSync(udd, { recursive: true, force: true }); } catch {}
  process.exit(0);
}
