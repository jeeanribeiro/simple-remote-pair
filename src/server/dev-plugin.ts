import type { Plugin } from 'vite';
import { attachHub, SessionHub } from './hub.js';
import { type FakeInjector, type InjectorChoice, resolveInjector } from './injector.js';

/**
 * Dev-mode integration: attaches the session hub to Vite's own HTTP server so
 * `npm run dev` is the entire stack — no second process, same origin, no proxy.
 *
 * Set SRP_INJECTOR=fake to record injections instead of moving the real mouse
 * (used by the e2e suite, which reads them back via /__test/injections).
 */
export function remotePairServer(): Plugin {
  return {
    name: 'simple-remote-pair:server',
    async configureServer(server) {
      // Middleware mode (tests) has no listener to attach to; the dev server
      // is always plain HTTP here, never the HTTP/2 variant Vite's type allows.
      const httpServer = server.httpServer as import('node:http').Server | null;
      if (!httpServer) return;
      const choice = (process.env.SRP_INJECTOR ?? 'auto') as InjectorChoice;
      const { injector, note } = await resolveInjector(choice);
      if (note) server.config.logger.warn(`[simple-remote-pair] ${note}`);
      const hub = new SessionHub({
        injector,
        log: (message) => server.config.logger.info(`[simple-remote-pair] ${message}`),
      });
      attachHub(httpServer, hub);

      if (injector.kind === 'fake') {
        const fake = injector as FakeInjector;
        server.middlewares.use('/__test/injections', (req, res) => {
          if (req.method === 'DELETE') {
            fake.clear();
            res.statusCode = 204;
            res.end();
            return;
          }
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ screen: fake.screenSize(), events: fake.events }));
        });
      }
    },
  };
}
