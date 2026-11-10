// 用 CDP 在页面里执行一段 JS 并打印结果（调试布局/状态用）
// node tools/eval.mjs "<url>" "<js表达式>" [等待毫秒]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const url = process.argv[2];
const expr = process.argv[3];
const waitMs = Number(process.argv[4] || 9000);
const chrome = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const port = 9900 + Math.floor(Math.random() * 90);
const udd = path.join(process.env.TEMP || '.', 'dsh-eval-' + Math.random().toString(36).slice(2, 9));
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
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      console.log('[exception] ' + (d.exception?.description || d.text).slice(0, 500));
    }
  };
  await send('Page.enable'); await send('Runtime.enable');
  await send('Page.navigate', { url });
  await sleep(waitMs);
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) console.log('[eval-exception] ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text).slice(0, 800));
  console.log(typeof r.result?.value === 'string' ? r.result.value : JSON.stringify(r.result?.value));
} catch (e) {
  console.error('eval 失败: ' + e.message);
} finally {
  try { ws?.close(); } catch {}
  try { proc.kill(); } catch {}
  await sleep(200);
  try { fs.rmSync(udd, { recursive: true, force: true }); } catch {}
  process.exit(0);
}
