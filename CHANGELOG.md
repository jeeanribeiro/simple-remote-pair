# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres
to [Semantic Versioning](https://semver.org/).

## [1.0.0] — 2026-07-19

Complete rewrite. The 0.x prototype (Express 4 + Socket.IO 2 + robotjs 0.6 +
simple-peer/wrtc, browserify build) is replaced end to end.

### Added

- Session codes: hosts get a 6-character one-time code; guests must present it
  before they can signal or send input — the 0.x server accepted input from
  anyone who could reach it.
- Host controls: per-guest control toggle, pause-all, kick, and a guest list.
- Guest UX: explicit take/release control (double-<kbd>Esc</kbd> to release),
  fullscreen with Keyboard Lock, live resolution/fps/RTT stats, reconnection
  with backoff, and clear end states (kicked / ended / not found).
- QR codes for the join URL, in the terminal and in the host view.
- `npx simple-remote-pair` CLI with `--port`, `--view-only`, `--max-guests`,
  `--injector`, `--quiet`.
- Graceful degradation: if the native input module can't load, the server runs
  view-only instead of failing to install or start.
- Stuck-key protection: every key/button a guest holds is released on
  disconnect, kick, revoke, and pause.
- Test suite: 39 unit/integration tests (real WebSockets against the hub) and
  a 5-scenario Playwright e2e suite exercising real WebRTC streams.
- Desktop app (`desktop/`): a Tauri build with a native Rust server (axum +
  `enigo`) that serves the same web client and speaks the same protocol, so
  guests need no Node.js. Installers for Windows, macOS (Intel & Apple
  Silicon), and Linux are attached to each GitHub release.
- CI (lint/typecheck/tests/build across OS × Node matrix, plus Rust
  fmt/clippy/test), CodeQL, release (npm + desktop installers) and GitHub
  Pages workflows.

### Changed

- Screen streaming now uses plain `RTCPeerConnection` browser-to-browser
  (goodbye `simple-peer` and the `wrtc` native module that was bundled into
  the browser build).
- Signaling and input moved from Socket.IO 2 to native WebSockets (`ws`) with
  a typed, schema-validated JSON protocol shared between client and server.
- Input handling: normalized [0, 1] coordinates with letterbox-accurate
  mapping, server-side move coalescing and per-guest rate limiting — replacing
  the 12-updates-per-second client throttle.
- `robotjs` 0.6 (node-gyp, required build tools) replaced by
  `@hurdlegroup/robotjs` with prebuilt N-API binaries.
- Build: browserify + terser replaced by Vite; the client JS bundle is ~10 kB
  gzipped (~13 kB with CSS and HTML). TypeScript strict mode everywhere.

### Removed

- The `#host` URL-hash convention (replaced by proper Home/Host/Join views).
- CORS middleware, EJS templating, and 600+ transitive dependencies — the
  runtime tree is now `ws`, `sirv`, `uqr` (+ optional robotjs).

[1.0.0]: https://github.com/jeeanribeiro/simple-remote-pair/releases/tag/v1.0.0
