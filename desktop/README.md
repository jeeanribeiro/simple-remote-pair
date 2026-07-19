# Simple Remote Pair — desktop app

A native desktop build of simple-remote-pair, packaged with [Tauri](https://tauri.app).
Download an installer from the [latest release](https://github.com/jeeanribeiro/simple-remote-pair/releases/latest) — Windows (`.exe`), macOS (`.dmg`, Intel & Apple Silicon), or Linux (`.AppImage`, `.deb`).

## Why a desktop app

The `npx simple-remote-pair` CLI needs Node.js installed. The desktop app is a
single ~10 MB installer with **no runtime dependencies** — double-click, share
your screen, hand out the code. Under the hood it runs the *same* web client and
speaks the *same* WebSocket protocol as the CLI; the only difference is the
server: a native Rust reimplementation (axum + [`enigo`](https://github.com/enigo-rs/enigo)
for input injection) instead of Node + robotjs.

```
             ┌─────────────────── desktop app (one binary) ──────────────────┐
   guests ──▶│  axum server (0.0.0.0)  ─┬─  embedded web client (host view)  │
  (browser)  │  session hub + enigo     │   loaded in the Tauri window       │
             └──────────────────────────┴────────────────────────────────────┘
```

The window loads the host view on `localhost` (a secure context, required for
screen capture); the server binds all interfaces so guests on your LAN/VPN can
reach it, and injects the LAN address into the page so join links and the QR
code point somewhere guests can actually open.

## Building from source

Prerequisites: [Rust](https://rustup.rs), Node.js 20.19+, and the
[Tauri system dependencies](https://tauri.app/start/prerequisites/) for your OS.

```sh
# from the repository root
npm install
npm run desktop:dev      # run the app against a debug build
npm run desktop:build    # produce installers in desktop/src-tauri/target/release/bundle
```

Both scripts build the web client first (into `dist/client`), which the Rust
binary embeds at compile time via `rust-embed`.

## Layout

```
desktop/src-tauri/
  src/
    main.rs       Tauri entry: starts the server, opens the window
    server.rs     axum HTTP + WebSocket server, embeds dist/client
    hub.rs        session hub — the Rust port of src/server/hub.ts
    injector.rs   enigo input injection on a dedicated thread
    keymap.rs     KeyboardEvent.key → enigo key mapping
    protocol.rs   the wire protocol, mirroring src/shared/protocol.ts
  tauri.conf.json Tauri + bundle configuration
```

The security model is identical to the CLI (see the [main README](../README.md#security-model)):
session codes gate everything, input is validated and gated on control, and
WebSocket upgrades are same-origin only.
