// 极简静态服务器：node tools/serve.mjs [port]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.argv[2] || 5183);
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.glsl': 'text/plain; charset=utf-8',
};

http.createServer((req, res) => {
  try {
    const url = decodeURIComponent((req.url || '/').split('?')[0]);
    let file = path.join(ROOT, url);
    if (url.endsWith('/')) file = path.join(file, 'index.html');
    if (!file.startsWith(ROOT)) { res.writeHead(403).end('forbidden'); return; }
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      file = path.join(ROOT, 'index.html');
      if (!fs.existsSync(file)) { res.writeHead(404).end('not found'); return; }
    }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-store',
      'Cross-Origin-Opener-Policy': 'same-origin',
    });
    const stream = fs.createReadStream(file);
    stream.on('error', () => { try { res.destroy(); } catch {} });
    stream.pipe(res);
  } catch (e) {
    res.writeHead(500).end(String(e));
  }
}).listen(PORT, '127.0.0.1', () => {
  console.log(`serving ${ROOT} -> http://127.0.0.1:${PORT}/`);
});
