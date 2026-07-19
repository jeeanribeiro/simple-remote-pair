import { createServer, type Server } from 'node:http';
import sirv from 'sirv';
import type { WebSocketServer } from 'ws';
import { attachHub, type HubOptions, SessionHub } from './hub.js';

export interface AppOptions extends HubOptions {
  /** Directory with the built client. Omit when another server serves it (dev). */
  staticDir?: string;
}

export interface App {
  server: Server;
  hub: SessionHub;
  wss: WebSocketServer;
  close(): Promise<void>;
}

const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "media-src 'self' blob:",
    "connect-src 'self' ws: wss:",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'none'",
  ].join('; '),
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

/** Create the production HTTP + WebSocket server. */
export function createApp(options: AppOptions): App {
  const { staticDir, ...hubOptions } = options;
  const serveStatic = staticDir
    ? sirv(staticDir, { etag: true, single: true, dev: false })
    : undefined;

  const server = createServer((req, res) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      res.setHeader(name, value);
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.statusCode = 405;
      res.setHeader('Allow', 'GET, HEAD');
      res.end('Method Not Allowed');
      return;
    }
    if (serveStatic) {
      serveStatic(req, res);
      return;
    }
    res.statusCode = 404;
    res.end('Not Found');
  });

  const hub = new SessionHub(hubOptions);
  const wss = attachHub(server, hub, { destroyUnknownUpgrades: true });

  return {
    server,
    hub,
    wss,
    close: () =>
      new Promise((resolve, reject) => {
        for (const client of wss.clients) client.terminate();
        wss.close();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
