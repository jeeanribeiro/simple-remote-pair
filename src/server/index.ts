import { readFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { renderUnicodeCompact } from 'uqr';
import { createApp } from './app.js';
import { type InjectorChoice, resolveInjector } from './injector.js';

const HELP = `simple-remote-pair — self-hosted screen sharing with remote control

Usage: simple-remote-pair [options]

Options:
  -p, --port <number>   Port to listen on (default: 3000)
      --host <address>  Address to bind (default: 0.0.0.0)
      --view-only       Never inject input; guests can only watch
      --injector <k>    Input backend: auto | robotjs | noop | fake (default: auto)
      --max-guests <n>  Guests allowed per session (default: 8)
  -q, --quiet           Only print errors
  -v, --version         Print version and exit
  -h, --help            Show this help

The server binds to your LAN so guests can reach it; sessions are gated by
one-time codes. Do not expose it to the public internet.`;

function fail(message: string): never {
  console.error(`simple-remote-pair: ${message}`);
  process.exit(1);
}

function lanAddresses(): string[] {
  const result: string[] = [];
  for (const nets of Object.values(networkInterfaces())) {
    for (const net of nets ?? []) {
      if (net.family === 'IPv4' && !net.internal) result.push(net.address);
    }
  }
  return result;
}

function positiveInt(value: string, name: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65_535) {
    fail(`invalid ${name}: ${value}`);
  }
  return parsed;
}

async function main(): Promise<void> {
  let args: ReturnType<typeof parseArgs>;
  try {
    args = parseArgs({
      options: {
        port: { type: 'string', short: 'p', default: '3000' },
        host: { type: 'string', default: '0.0.0.0' },
        'view-only': { type: 'boolean', default: false },
        injector: { type: 'string', default: process.env.SRP_INJECTOR ?? 'auto' },
        'max-guests': { type: 'string', default: '8' },
        quiet: { type: 'boolean', short: 'q', default: false },
        version: { type: 'boolean', short: 'v', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
  const values = args.values as {
    port: string;
    host: string;
    'view-only': boolean;
    injector: string;
    'max-guests': string;
    quiet: boolean;
    version: boolean;
    help: boolean;
  };

  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
    version: string;
  };

  if (values.help) {
    console.log(HELP);
    return;
  }
  if (values.version) {
    console.log(pkg.version);
    return;
  }

  const choices: InjectorChoice[] = ['auto', 'robotjs', 'noop', 'fake'];
  if (!choices.includes(values.injector as InjectorChoice)) {
    fail(`invalid --injector: ${values.injector} (expected ${choices.join(' | ')})`);
  }

  const port = positiveInt(values.port, '--port');
  const maxGuests = positiveInt(values['max-guests'], '--max-guests');
  const quiet = values.quiet;

  const { injector, note } = await resolveInjector(values.injector as InjectorChoice).catch(
    (err: Error) => fail(err.message),
  );
  if (note && !quiet) console.warn(`! ${note}`);

  const app = createApp({
    injector,
    controlEnabled: !values['view-only'],
    maxGuests,
    staticDir: fileURLToPath(new URL('../client', import.meta.url)),
    log: quiet ? () => {} : (message) => console.log(`  ${message}`),
  });

  app.server.listen(port, values.host, () => {
    if (quiet) return;
    const urls =
      values.host === '0.0.0.0' || values.host === '::'
        ? ['localhost', ...lanAddresses()].map((addr) => `http://${addr}:${port}`)
        : [`http://${values.host}:${port}`];
    const control = values['view-only']
      ? 'disabled (--view-only)'
      : injector.available
        ? `enabled via ${injector.kind}`
        : 'unavailable — view-only';

    console.log(`\n  simple-remote-pair v${pkg.version}\n`);
    console.log(`  Local:    ${urls[0]}`);
    for (const url of urls.slice(1)) console.log(`  Network:  ${url}`);
    console.log(`  Control:  ${control}\n`);
    const shareUrl = urls[1] ?? urls[0];
    if (shareUrl) {
      console.log(
        renderUnicodeCompact(shareUrl)
          .split('\n')
          .map((line) => `  ${line}`)
          .join('\n'),
      );
      console.log(`\n  Scan to open ${shareUrl} on another device.\n`);
    }
  });

  const shutdown = (): void => {
    if (!quiet) console.log('\n  shutting down…');
    void app.close().finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

await main();
