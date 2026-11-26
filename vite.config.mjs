import { cpSync, mkdirSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';

const source = resolve('node_modules/docxodus/dist/wasm/_framework');
const target = resolve('public/wasm/_framework');
mkdirSync(target, { recursive: true });
for (const name of readdirSync(source)) {
  if (!name.endsWith('.br')) cpSync(resolve(source, name), resolve(target, name));
}

export default defineConfig({
  worker: { format: 'es' },
  server: { host: '127.0.0.1', port: 4177, strictPort: true },
});
