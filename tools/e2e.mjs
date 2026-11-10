// 端到端交互自检：用 CDP 驱动真实 Chrome，跑一遍「环绕 → 拆解 → 飞行 → 跃迁 → 站内漫游 → 行星展厅」
// node tools/e2e.mjs [baseUrl] [outDir]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const base = process.argv[2] || 'http://127.0.0.1:5183/';
const outDir = path.resolve(ROOT, process.argv[3] || 'shots/e2e');
fs.mkdirSync(outDir, { recursive: true });

const chrome = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const port = 9300 + Math.floor(Math.random() * 400);
const udd = path.join(process.env.TEMP || '.', 'dsh-e2e-' + Math.random().toString(36).slice(2, 9));

const proc = spawn(chrome, [
  '--headless=new', '--no-sandbox', '--disable-gpu-sandbox', '--hide-scrollbars',
  '--window-size=1600,900', '--enable-unsafe-swiftshader', '--use-angle=swiftshader',
  '--force-device-scale-factor=1', '--disable-lcd-text', '--font-render-hinting=none',
  '--autoplay-policy=no-user-gesture-required',
  `--remote-debugging-port=${port}`, `--user-data-dir=${udd}`, 'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForJson(url, tries = 80) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(url); if (r.ok) return await r.json(); } catch {}
    await sleep(250);
  }
  throw new Error('devtools not ready: ' + url);
}

let ws, nextId = 1;
const pending = new Map();
const consoleErrors = [];

function send(method, params = {}) {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((res, rej) => pending.set(id, { res, rej }));
}

const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error('evaluate failed: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result.value;
};

async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  const p = path.join(outDir, name + '.png');
  fs.writeFileSync(p, Buffer.from(r.data, 'base64'));
  console.log(`  · shot ${name}.png (${(fs.statSync(p).size / 1024).toFixed(0)} KB)`);
}

const KEYS = {
  KeyF: [70, 'f'], KeyX: [88, 'x'], KeyE: [69, 'e'], KeyM: [77, 'm'],
  KeyW: [87, 'w'], KeyD: [68, 'd'], ShiftLeft: [16, 'Shift'],
  KeyI: [73, 'i'], KeyP: [80, 'p'], KeyJ: [74, 'j'],
  ArrowLeft: [37, 'ArrowLeft'], ArrowRight: [39, 'ArrowRight'],
  Space: [32, ' '], Tab: [9, 'Tab'], Escape: [27, 'Escape'], Enter: [13, 'Enter'],
};

async function key(code, type = 'keyDown') {
  const [vk, k] = KEYS[code] || [0, ''];
  await send('Input.dispatchKeyEvent', {
    type, code, key: k, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk,
  });
}
async function press(code, ms = 90) { await key(code, 'keyDown'); await sleep(ms); await key(code, 'keyUp'); }

async function tapAt(selector) {
  const rect = await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  if (!rect) throw new Error('element not found: ' + selector);
  for (const type of ['mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', { type, x: rect.x, y: rect.y, button: 'left', clickCount: 1, buttons: 1 });
  }
  await sleep(140);
}

const results = [];
const check = (name, ok, extra = '') => { results.push({ name, ok, extra }); console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`); };

try {
  const targets = await waitForJson(`http://127.0.0.1:${port}/json/list`);
  const page = targets.find((t) => t.type === 'page');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id); pending.delete(msg.id);
      msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
    } else if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
      consoleErrors.push(msg.params.entry.text);
    } else if (msg.method === 'Runtime.exceptionThrown') {
      consoleErrors.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
    }
  };
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Log.enable');

  const MODE = () => evaluate('window.__APP && window.__APP.STATE.mode');

  // ── 标题页 ──
  console.log('▶ title');
  await send('Page.navigate', { url: base + '?mode=title' });
  for (let i = 0; i < 120; i++) {
    if (await evaluate('window.__READY === true')) break;
    await sleep(250);
  }
  check('first frame ready __READY', await evaluate('window.__READY === true'));
  await sleep(2600);
  check('starts in title mode', (await MODE()) === 'title', String(await MODE()));
  await shot('01-title');

  // 点「进入序章」→ 环绕视角（走真实 transitionTo 黑场 + 5 秒推镜）
  await tapAt('#enter');
  await sleep(3400);
  check('enter orbit view', (await MODE()) === 'orbit', String(await MODE()));
  await shot('02-orbit-intro');
  await sleep(2600);
  await shot('03-orbit');

  const mods = await evaluate('window.__APP.station.modules.length');
  check('module count 22', mods === 22, String(mods));

  // ── 拆解 / 重组 ──
  await press('KeyX');
  await sleep(2500);
  const ex = await evaluate('window.__APP.station.explodeAmount');
  check('explode expanded', ex > 0.85, 'explodeAmount=' + Number(ex).toFixed(2));
  check('all 22 modules detached', (await evaluate('window.__APP.station.modules.filter(m=>window.__APP.station.isDetached(m.id)).length')) === 22);
  await shot('04-explode');

  await tapAt('#module-list .mod');
  await sleep(300);
  check('select one module', !!(await evaluate('!!window.__APP.STATE.selected')));
  await press('KeyE');
  await sleep(1300);
  const detInfo = await evaluate(`(() => { const sel = window.__APP.STATE.selected;
    return JSON.stringify({ sel: sel && sel.id, det: sel ? window.__APP.station.isDetached(sel.id) : null,
      n: window.__APP.station.modules.filter(m=>window.__APP.station.isDetached(m.id)).length }); })()`);
  check('reattach single module', JSON.parse(detInfo).n === 21, detInfo);
  await press('KeyE');
  await sleep(1300);
  check('detach single module again', (await evaluate('window.__APP.station.modules.filter(m=>window.__APP.station.isDetached(m.id)).length')) === 22);

  await press('KeyX');
  await sleep(2200);
  check('reassembled', (await evaluate('window.__APP.station.explodeAmount')) < 0.15);
  await shot('05-reassembled');

  // ── 飞行 ──
  await press('KeyF');
  await sleep(2600);
  check('enter flight mode', (await MODE()) === 'flight', String(await MODE()));
  await shot('06-flight');

  await key('KeyW', 'keyDown'); await sleep(1600); await key('KeyW', 'keyUp');
  await key('KeyD', 'keyDown'); await sleep(520); await key('KeyD', 'keyUp');
  const spd = await evaluate('window.__APP.ship.state.speed');
  check('thrust accelerates', spd > 8, 'speed=' + Number(spd).toFixed(1));
  const p0 = await evaluate('window.__APP.ship.position.toArray().join(",")');
  await sleep(600);
  const p1 = await evaluate('window.__APP.ship.position.toArray().join(",")');
  check('ship keeps moving', p0 !== p1);
  await shot('07-flight-moving');

  // ── 目标 / 跃迁 ──
  const t0 = await evaluate('window.__APP.STATE.targetIdx');
  await press('Tab');
  await sleep(260);
  const t1 = await evaluate('window.__APP.STATE.targetIdx');
  check('cycle target lock', t0 !== t1, `${t0} -> ${t1}`);

  await press('Space');
  await sleep(500);
  check('warp triggered', (await evaluate('window.__APP.ship.state.warping')) === true);
  await shot('08-warp');
  await sleep(2600);

  // ── 视角切换 ──
  await press('KeyF');
  await sleep(1000);
  check('switch to cockpit', (await evaluate('window.__APP.ship.cameraMode')) === 'cockpit');
  await shot('09-cockpit');
  await press('KeyF');
  await sleep(900);
  check('switch back to chase', (await evaluate('window.__APP.ship.cameraMode')) === 'chase');

  // ── 返回 + 静音 ──
  await press('Escape');
  await sleep(3000);
  check('back to orbit view', (await MODE()) === 'orbit', String(await MODE()));
  await press('KeyM');
  await sleep(200);
  check('mute toggle no throw', (await evaluate('window.__APP ? true : false')) === true);

  check('HUD module list 22 rows', (await evaluate('document.querySelector("#module-list").children.length')) === 22);

  // ── 任务线 ──
  const mList = await evaluate('window.__APP.missions.list.length');
  check('mission chain 6 steps', mList === 6, String(mList));
  const mCur = await evaluate('(() => { const c = window.__APP.missions.current(); return c ? JSON.stringify({ id: c.mission.id, d: Math.round(c.distance) }) : null; })()');
  check('mission target resolvable', !!mCur, String(mCur));

  // ── 站内漫游 ──
  await press('KeyI');
  await sleep(2800);
  check('enter interior', (await MODE()) === 'interior', String(await MODE()));
  const hots = await evaluate('window.__APP.interior.hotspots.length');
  check('interior hotspots >= 6', hots >= 6, String(hots));
  await shot('10-interior');
  const ip0 = await evaluate('window.__APP.interior.position.toArray().join(",")');
  await key('KeyW', 'keyDown'); await sleep(1400); await key('KeyW', 'keyUp');
  await sleep(200);
  const ip1 = await evaluate('window.__APP.interior.position.toArray().join(",")');
  check('interior walking moves player', ip0 !== ip1, ip0 + ' -> ' + ip1);
  await shot('11-interior-walk');
  await press('KeyE');
  await sleep(400);
  await press('Escape');
  await sleep(2800);
  check('leave interior', (await MODE()) === 'orbit', String(await MODE()));

  // ── 行星展厅 ──
  await press('KeyP');
  await sleep(2800);
  check('enter planet archive', (await MODE()) === 'planet', String(await MODE()));
  const pb0 = await evaluate('window.__APP.planetarium.current.id');
  await shot('12-planet-saturn');
  await press('ArrowRight');
  await sleep(1400);
  const pb1 = await evaluate('window.__APP.planetarium.current.id');
  check('switch planet in archive', pb0 !== pb1, `${pb0} -> ${pb1}`);
  await shot('13-planet-' + pb1);
  await press('Escape');
  await sleep(2800);
  check('leave planet archive', (await MODE()) === 'orbit', String(await MODE()));

  console.log('\nconsole errors: ' + consoleErrors.length);
  consoleErrors.slice(0, 8).forEach((e) => console.log('  ! ' + String(e).split('\n')[0].slice(0, 200)));
  check('no JS errors', consoleErrors.length === 0, consoleErrors.length ? String(consoleErrors[0]).slice(0, 120) : '');
} catch (err) {
  console.error('E2E exception: ' + err.message);
  results.push({ name: 'E2E run', ok: false, extra: err.message });
} finally {
  const bad = results.filter((r) => !r.ok);
  const lines = results.map((r) => `${r.ok ? 'PASS' : 'FAIL'} ${r.name}${r.extra ? ' | ' + r.extra : ''}`);
  fs.writeFileSync(path.join(outDir, 'report.txt'), lines.join('\n') + '\n');
  console.log(`\n===== ${results.length - bad.length}/${results.length} passed =====`);
  try { ws?.close(); } catch {}
  try { proc.kill(); } catch {}
  await sleep(300);
  try { fs.rmSync(udd, { recursive: true, force: true }); } catch {}
  process.exit(bad.length ? 1 : 0);
}
