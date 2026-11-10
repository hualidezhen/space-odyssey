// 将 three.js 及其所需 addons 下载到本地 vendor 目录，保证成品完全离线可用。
import fs from 'node:fs/promises';
import path from 'node:path';

const VERSION = '0.160.0';
const BASE = `https://unpkg.com/three@${VERSION}/`;
const ROOT = path.resolve(import.meta.dirname, '..');
const JSM = 'examples/jsm/';

const ENTRIES = [
  'postprocessing/EffectComposer.js',
  'postprocessing/RenderPass.js',
  'postprocessing/ShaderPass.js',
  'postprocessing/UnrealBloomPass.js',
  'postprocessing/OutputPass.js',
  'shaders/CopyShader.js',
  'shaders/LuminosityHighPassShader.js',
  'shaders/OutputShader.js',
  'utils/BufferGeometryUtils.js',
];

const seen = new Set();
const queue = [];

function norm(p) {
  const out = [];
  for (const seg of p.split('/')) {
    if (seg === '.' || seg === '') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return out.join('/');
}

async function save(relToJsm, url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  const text = await r.text();
  const outPath = path.join(ROOT, 'vendor/addons', relToJsm);
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  let body = text;
  if (relToJsm.endsWith('.js')) {
    const re = /from\s+['"]([^'"]+)['"]/g;
    let m;
    while ((m = re.exec(text))) {
      const spec = m[1];
      if (spec.startsWith('.')) {
        const child = norm(path.posix.join(path.posix.dirname(relToJsm), spec));
        if (!seen.has(child)) {
          seen.add(child);
          queue.push(child);
        }
      }
    }
  }
  await fs.writeFile(outPath, body, 'utf8');
  return body.length;
}

async function main() {
  // 核心库
  const core = await fetch(BASE + 'build/three.module.js');
  if (!core.ok) throw new Error('core ' + core.status);
  const coreText = await core.text();
  await fs.mkdir(path.join(ROOT, 'vendor'), { recursive: true });
  await fs.writeFile(path.join(ROOT, 'vendor/three.module.js'), coreText, 'utf8');
  console.log('three.module.js', (coreText.length / 1024).toFixed(0) + 'KB');

  for (const e of ENTRIES) {
    if (!seen.has(e)) { seen.add(e); queue.push(e); }
  }
  let total = 0;
  while (queue.length) {
    const rel = queue.shift();
    total += await save(rel, BASE + JSM + rel);
  }
  console.log('addons files:', seen.size, 'bytes:', total);
}

main().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
