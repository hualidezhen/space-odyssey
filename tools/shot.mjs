// 无头 Chrome 截图：node tools/shot.mjs "<url>" <out.png> [width] [height] [budgetMs]
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const [, , url, out, w = '1600', h = '900', budget = '9000'] = process.argv;
if (!url || !out) { console.error('usage: node tools/shot.mjs "<url>" <out.png> [w] [h] [budgetMs]'); process.exit(2); }

const ROOT = path.resolve(import.meta.dirname, '..');
const outPath = path.isAbsolute(out) ? out : path.join(ROOT, out);
fs.mkdirSync(path.dirname(outPath), { recursive: true });
try { fs.unlinkSync(outPath); } catch {}

const chrome = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const udd = path.join(process.env.TEMP || '.', 'dsh-chrome-' + Math.random().toString(36).slice(2, 10));

const args = [
  '--headless=new', '--no-sandbox', '--disable-gpu-sandbox', '--hide-scrollbars',
  `--window-size=${w},${h}`, `--virtual-time-budget=${budget}`,
  '--enable-unsafe-swiftshader', '--use-angle=swiftshader',
  '--force-device-scale-factor=1', '--disable-lcd-text', '--font-render-hinting=none',
  `--user-data-dir=${udd}`, `--screenshot=${outPath}`, url,
];

const r = spawnSync(chrome, args, { stdio: 'inherit', timeout: 180000 });
try { fs.rmSync(udd, { recursive: true, force: true }); } catch {}

if (fs.existsSync(outPath)) {
  console.log(`SHOT ${outPath} (${(fs.statSync(outPath).size / 1024).toFixed(0)} KB) exit=${r.status}`);
} else {
  console.error('SHOT FAILED exit=' + r.status);
  process.exit(1);
}
