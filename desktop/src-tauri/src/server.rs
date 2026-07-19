//! Axum HTTP + WebSocket server. Serves the embedded web client and runs the
//! session hub, exactly like the Node server but in-process with the desktop app.

use std::net::SocketAddr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use axum::{
    body::Body,
    extract::{
        ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade},
        State,
    },
    http::{header, HeaderMap, StatusCode, Uri},
    response::{IntoResponse, Response},
    routing::get,
    Router,
};
use futures_util::{SinkExt, StreamExt};
use rust_embed::RustEmbed;
use tokio::sync::mpsc;

use crate::hub::{parse_close_sentinel, ConnId, Hub};
use crate::injector::Injector;
use crate::protocol::WS_PATH;

/// The built web client (`dist/client`) baked into the binary at compile time.
#[derive(RustEmbed)]
#[folder = "../../dist/client"]
struct WebAssets;

#[derive(Clone)]
pub struct AppState {
    hub: Arc<Mutex<Hub>>,
    /// LAN base URL injected into index.html so join links reach guests.
    public_base: Arc<str>,
    next_conn: Arc<AtomicU64>,
}

pub struct RunningServer {
    pub port: u16,
    pub public_base: String,
    pub injector_available: bool,
}

/// Bind and serve. Returns once the listener is bound; the server runs on the
/// provided runtime until the process exits.
pub async fn serve(
    bind: SocketAddr,
    public_ip: String,
    injector: Injector,
) -> std::io::Result<RunningServer> {
    let listener = tokio::net::TcpListener::bind(bind).await?;
    let port = listener.local_addr()?.port();
    let public_base = format!("http://{public_ip}:{port}/");
    let injector_available = injector.available();

    let state = AppState {
        hub: Arc::new(Mutex::new(Hub::new(injector))),
        public_base: Arc::from(public_base.as_str()),
        next_conn: Arc::new(AtomicU64::new(1)),
    };

    let app = Router::new()
        .route(WS_PATH, get(ws_handler))
        .fallback(static_handler)
        .with_state(state);

    tokio::spawn(async move {
        let _ = axum::serve(
            listener,
            app.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await;
    });

    Ok(RunningServer {
        port,
        public_base,
        injector_available,
    })
}

async fn ws_handler(
    ws: WebSocketUpgrade,
    headers: HeaderMap,
    State(state): State<AppState>,
) -> Response {
    // Same-origin check: browsers always send Origin, and the app's own client
    // connects via its page host. Reject a foreign Origin (cross-site hijack);
    // allow Origin-less clients (native tools).
    if let Some(origin) = headers.get(header::ORIGIN) {
        let host = headers.get(header::HOST).and_then(|h| h.to_str().ok());
        let origin_host = origin
            .to_str()
            .ok()
            .and_then(|o| o.parse::<Uri>().ok())
            .and_then(|u| u.authority().map(|a| a.as_str().to_string()));
        if origin_host.as_deref() != host {
            return (StatusCode::FORBIDDEN, "cross-origin websocket refused").into_response();
        }
    }
    ws.on_upgrade(move |socket| handle_socket(socket, state))
}

async fn handle_socket(socket: WebSocket, state: AppState) {
    let conn: ConnId = state.next_conn.fetch_add(1, Ordering::Relaxed);
    let (mut sink, mut stream) = socket.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();

    state.hub.lock().unwrap().add_connection(conn, tx);

    // Writer task: drains outgoing frames. A close sentinel becomes a real
    // WebSocket close frame with the protocol's code.
    let writer = tokio::spawn(async move {
        while let Some(frame) = rx.recv().await {
            if let Some(code) = parse_close_sentinel(&frame) {
                let _ = sink
                    .send(Message::Close(Some(CloseFrame {
                        code,
                        reason: "".into(),
                    })))
                    .await;
                break;
            }
            if sink.send(Message::Text(frame.into())).await.is_err() {
                break;
            }
        }
    });

    while let Some(Ok(message)) = stream.next().await {
        match message {
            Message::Text(text) => {
                let outcome = state.hub.lock().unwrap().handle_text(conn, &text);
                if outcome.close.is_some() {
                    break;
                }
            }
            Message::Close(_) => break,
            _ => {}
        }
    }

    state.hub.lock().unwrap().remove_connection(conn);
    writer.abort();
}

async fn static_handler(uri: Uri, State(state): State<AppState>) -> Response {
    let path = uri.path().trim_start_matches('/');
    let candidate = if path.is_empty() { "index.html" } else { path };

    // Serve the asset if present; otherwise fall back to index.html (SPA).
    let (data, name) = match WebAssets::get(candidate) {
        Some(file) => (file.data, candidate.to_string()),
        None => match WebAssets::get("index.html") {
            Some(file) => (file.data, "index.html".to_string()),
            None => return (StatusCode::NOT_FOUND, "not found").into_response(),
        },
    };

    let mime = mime_guess::from_path(&name).first_or_octet_stream();

    if name == "index.html" {
        // Inject the LAN base so the host view's join links/QR are reachable
        // even though the desktop window itself is loaded on localhost.
        let html = String::from_utf8_lossy(&data).replacen(
            "<head>",
            &format!(
                "<head><script>window.__srpPublicBase__={:?};</script>",
                state.public_base.as_ref()
            ),
            1,
        );
        return Response::builder()
            .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
            .body(Body::from(html))
            .unwrap();
    }

    Response::builder()
        .header(header::CONTENT_TYPE, mime.as_ref())
        .body(Body::from(data.into_owned()))
        .unwrap()
}
