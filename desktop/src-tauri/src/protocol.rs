//! Wire protocol — the Rust mirror of `src/shared/protocol.ts`. The desktop
//! app serves the identical web client and must speak the identical messages.

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const WS_PATH: &str = "/ws";
pub const SESSION_CODE_LENGTH: usize = 6;
/// Unambiguous alphabet: no 0/O, 1/I/L.
pub const SESSION_CODE_ALPHABET: &[u8] = b"ABCDEFGHJKMNPQRSTUVWXYZ23456789";
pub const MAX_GUEST_NAME_LENGTH: usize = 24;

/// Mouse buttons follow `MouseEvent.button`: 0 = left, 1 = middle, 2 = right.
pub type MouseButton = u8;

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "k")]
pub enum InputEvent {
    #[serde(rename = "move")]
    Move { x: f64, y: f64 },
    #[serde(rename = "down")]
    Down { x: f64, y: f64, button: MouseButton },
    #[serde(rename = "up")]
    Up { button: MouseButton },
    #[serde(rename = "wheel")]
    Wheel { dx: f64, dy: f64 },
    #[serde(rename = "key")]
    Key { key: String, down: bool },
}

impl InputEvent {
    /// Reject anything outside the protocol's accepted ranges.
    pub fn is_valid(&self) -> bool {
        let norm = |v: f64| v.is_finite() && (0.0..=1.0).contains(&v);
        match self {
            InputEvent::Move { x, y } => norm(*x) && norm(*y),
            InputEvent::Down { x, y, button } => norm(*x) && norm(*y) && *button <= 2,
            InputEvent::Up { button } => *button <= 2,
            InputEvent::Wheel { dx, dy } => dx.is_finite() && dy.is_finite(),
            InputEvent::Key { key, .. } => !key.is_empty() && key.len() <= 32,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(tag = "t")]
pub enum ClientMessage {
    #[serde(rename = "host:create")]
    HostCreate,
    #[serde(rename = "guest:join")]
    GuestJoin { code: String, name: Option<String> },
    #[serde(rename = "signal")]
    Signal {
        #[serde(default)]
        to: Option<String>,
        data: Value,
    },
    #[serde(rename = "input")]
    Input { ev: InputEvent },
    #[serde(rename = "host:control")]
    HostControl {
        #[serde(rename = "guestId")]
        guest_id: String,
        control: bool,
    },
    #[serde(rename = "host:kick")]
    HostKick {
        #[serde(rename = "guestId")]
        guest_id: String,
    },
    #[serde(rename = "host:pause")]
    HostPause { paused: bool },
}

#[derive(Debug, Clone, Serialize)]
pub struct GuestInfo {
    pub id: String,
    pub name: String,
    pub control: bool,
}

#[derive(Debug, Serialize)]
#[serde(tag = "t")]
pub enum ServerMessage {
    #[serde(rename = "session:created")]
    SessionCreated { code: String },
    #[serde(rename = "guest:joined")]
    GuestJoined {
        #[serde(rename = "guestId")]
        guest_id: String,
        name: String,
        control: bool,
        paused: bool,
    },
    #[serde(rename = "guest:connected")]
    GuestConnected { guest: GuestInfo },
    #[serde(rename = "guest:disconnected")]
    GuestDisconnected {
        #[serde(rename = "guestId")]
        guest_id: String,
    },
    #[serde(rename = "signal")]
    Signal { from: String, data: Value },
    #[serde(rename = "control:changed")]
    ControlChanged { control: bool, paused: bool },
    #[serde(rename = "session:ended")]
    SessionEnded,
    #[serde(rename = "injector:status")]
    InjectorStatus { available: bool },
    #[serde(rename = "error")]
    Error { code: String, message: String },
}

impl ServerMessage {
    pub fn error(code: &str, message: &str) -> Self {
        ServerMessage::Error {
            code: code.to_string(),
            message: message.to_string(),
        }
    }

    pub fn to_json(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|_| "{}".to_string())
    }
}

/// Normalize an untrusted display name into something safe to render.
pub fn sanitize_guest_name(name: Option<&str>, fallback: &str) -> String {
    let Some(name) = name else {
        return fallback.to_string();
    };
    let cleaned: String = name
        .chars()
        .filter(|c| !c.is_control())
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let cleaned: String = cleaned.chars().take(MAX_GUEST_NAME_LENGTH).collect();
    if cleaned.is_empty() {
        fallback.to_string()
    } else {
        cleaned
    }
}
