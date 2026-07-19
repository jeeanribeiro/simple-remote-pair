# Contributing

Thanks for your interest in improving simple-remote-pair!

## Getting set up

```sh
git clone https://github.com/jeeanribeiro/simple-remote-pair.git
cd simple-remote-pair
npm install
npm run dev
```

`npm run dev` starts Vite with the session server attached — one process, one port. Open two tabs (one `#/host`, one guest) to exercise the full flow locally. Set `SRP_INJECTOR=fake` if you don't want your real mouse moving while you test.

## Before you open a PR

```sh
npm run verify   # lint + typecheck + unit tests + build
npm run test:e2e # Playwright end-to-end suite (npx playwright install chromium once)
```

- Keep the runtime dependency tree small — that's a feature of this project. New runtime dependencies need a strong justification.
- New protocol messages belong in `src/shared/protocol.ts` with a validator and a test.
- Anything that touches input injection needs coverage in `tests/hub.test.ts` (the fake injector records everything).
- User-facing behavior changes should update the e2e suite and, if visible, the screenshots (`node scripts/screenshots.mjs`).

## Reporting bugs

Open an issue with your OS, Node version, browser, and what the server printed at startup (it names the active injector — that's usually the interesting part).

For security issues, please follow [SECURITY.md](SECURITY.md) instead of opening a public issue.
