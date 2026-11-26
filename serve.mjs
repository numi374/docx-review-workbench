import { createReadStream, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';

const root = fileURLToPath(new URL('./dist', import.meta.url));
const port = Number(process.env.DOCX_PROTO_PORT ?? 4177);
const mime = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm', '.json': 'application/json; charset=utf-8',
  '.dat': 'application/octet-stream',
};
const csp = [
  "default-src 'none'", "script-src 'self' 'wasm-unsafe-eval'", "style-src 'self' 'unsafe-inline'",
  "connect-src 'self'", "img-src data: blob:", "font-src 'self' data:", "worker-src 'self'",
  "base-uri 'none'", "frame-ancestors 'none'", "form-action 'none'",
].join('; ');

createServer((request, response) => {
  if (request.headers.host !== `127.0.0.1:${port}`) {
    response.writeHead(403).end();
    return;
  }
  if (!['GET', 'HEAD'].includes(request.method)) {
    response.writeHead(405).end();
    return;
  }
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
    const file = resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!file.startsWith(root + sep) || !statSync(file).isFile()) throw new Error('Missing file');
    response.writeHead(200, {
      'Content-Type': mime[extname(file)] ?? 'application/octet-stream',
      'Content-Security-Policy': csp,
      'X-Content-Type-Options': 'nosniff',
      'Cross-Origin-Resource-Policy': 'same-origin',
    });
    if (request.method === 'HEAD') response.end();
    else createReadStream(file).pipe(response);
  } catch {
    response.writeHead(404).end('Not found');
  }
}).listen(port, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${port}/`;
  console.log(`DOCX review workbench: ${url}`);
  if (process.platform === 'win32' && process.argv.includes('--open')) {
    execFile('rundll32.exe', ['url.dll,FileProtocolHandler', url], { windowsHide: true }, (error) => {
      if (error) console.log(`Open ${url} in Edge or Chrome.`);
    });
  }
});
