// Simple Remote Pair — desktop app.
//
// Runs the same session server the `npx` build uses (screen sharing over
// WebRTC, remote input via a native injector) in-process, then opens a window
// on the host view. Guests join from any browser on the LAN.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod hub;
mod injector;
mod keymap;
mod protocol;
mod server;

use std::net::{Ipv4Addr, SocketAddr};

use tauri::{WebviewUrl, WebviewWindowBuilder};

use injector::Injector;

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let injector = Injector::spawn();
                let public_ip = local_ip_address::local_ip()
                    .map(|ip| ip.to_string())
                    .unwrap_or_else(|_| "127.0.0.1".to_string());
                // Bind all interfaces so LAN guests can reach us; port 0 asks the
                // OS for a free port.
                let bind = SocketAddr::from((Ipv4Addr::UNSPECIFIED, 0));
                match server::serve(bind, public_ip, injector).await {
                    Ok(running) => {
                        println!(
                            "simple-remote-pair listening — guests: {} — control: {}",
                            running.public_base,
                            if running.injector_available {
                                "enabled"
                            } else {
                                "view-only"
                            },
                        );
                        // Load the window on localhost: a secure context, which
                        // getDisplayMedia requires. Guests use the LAN base the
                        // server injects into the page.
                        let url = format!("http://localhost:{}/#/host", running.port);
                        let build = WebviewWindowBuilder::new(
                            &handle,
                            "main",
                            WebviewUrl::External(url.parse().expect("valid url")),
                        )
                        .title("Simple Remote Pair")
                        .inner_size(1100.0, 760.0)
                        .min_inner_size(720.0, 560.0);
                        if let Err(err) = build.build() {
                            eprintln!("failed to open window: {err}");
                            handle.exit(1);
                        }
                    }
                    Err(err) => {
                        eprintln!("failed to start server: {err}");
                        handle.exit(1);
                    }
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Simple Remote Pair");
}
