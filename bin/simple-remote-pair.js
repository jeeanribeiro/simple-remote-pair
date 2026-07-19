#!/usr/bin/env node
import { existsSync } from 'node:fs';

const entry = new URL('../dist/server/index.js', import.meta.url);
if (!existsSync(entry)) {
  console.error(
    'simple-remote-pair: build output missing. Run `npm run build` first (this only happens when running from a source checkout).',
  );
  process.exit(1);
}
await import(entry.href);
