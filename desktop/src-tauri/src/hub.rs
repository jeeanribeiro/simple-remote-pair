//! Session hub — the Rust port of `src/server/hub.ts`.
//!
//! Pairs hosts with guests, relays WebRTC signaling, and feeds validated guest
//! input into the injector. One `Hub` is shared behind a `Mutex`; every method
//! is synchronous and short (outgoing frames are pushed into unbounded channels
//! without awaiting), so the lock is never held across an await point.

use std::collections::{HashMap, HashSet};

use rand::Rng;
use serde_json::Value;
use tokio::sync::mpsc::UnboundedSender;

use crate::injector::{InjectCmd, Injector};
use crate::protocol::{
    sanitize_guest_name, ClientMessage, GuestInfo, InputEvent, ServerMessage,
    SESSION_CODE_ALPHABET, SESSION_CODE_LENGTH,
};

const MAX_GUESTS: usize = 8;
const MAX_SIGNAL_BYTES: usize = 64 * 1024;
const MAX_FAILED_JOINS: u32 = 10;
pub const CLOSE_KICKED: u16 = 4001;
pub const CLOSE_SESSION_ENDED: u16 = 4002;

pub type ConnId = u64;

/// What the connection task should do after a hub call.
#[derive(Default)]
pub struct Outcome {
    /// Close this connection with the given WebSocket code + reason.
    pub close: Option<(u16, &'static str)>,
}

struct Guest {
    control: bool,
    conn: ConnId,
    pressed_keys: HashSet<String>,
    pressed_buttons: HashSet<u8>,
    wheel_remainder: (f64, f64),
}

struct Session {
    host: ConnId,
    guests: HashMap<String, Guest>,
    paused: bool,
    next_guest_number: u32,
}

enum Role {
    Host { code: String },
    Guest { code: String, guest_id: String },
}

pub struct Hub {
    senders: HashMap<ConnId, UnboundedSender<String>>,
    roles: HashMap<ConnId, Role>,
    sessions: HashMap<String, Session>,
    failed_joins: HashMap<ConnId, u32>,
    injector: Injector,
}

impl Hub {
    pub fn new(injector: Injector) -> Self {
        Hub {
            senders: HashMap::new(),
            roles: HashMap::new(),
            sessions: HashMap::new(),
            failed_joins: HashMap::new(),
            injector,
        }
    }

    fn injection_available(&self) -> bool {
        self.injector.available()
    }

    pub fn add_connection(&mut self, conn: ConnId, sender: UnboundedSender<String>) {
        self.senders.insert(conn, sender);
    }

    fn send(&self, conn: ConnId, message: &ServerMessage) {
        if let Some(tx) = self.senders.get(&conn) {
            let _ = tx.send(message.to_json());
        }
    }

    pub fn handle_text(&mut self, conn: ConnId, text: &str) -> Outcome {
        let Ok(message) = serde_json::from_str::<ClientMessage>(text) else {
            return self.on_bad_message(conn);
        };
        match message {
            ClientMessage::HostCreate => self.create_session(conn),
            ClientMessage::GuestJoin { code, name } => {
                self.join_session(conn, &code, name.as_deref())
            }
            ClientMessage::Signal { to, data } => self.route_signal(conn, to.as_deref(), data),
            ClientMessage::Input { ev } => self.handle_input(conn, ev),
            ClientMessage::HostControl { guest_id, control } => {
                self.set_guest_control(conn, &guest_id, control)
            }
            ClientMessage::HostKick { guest_id } => self.kick_guest(conn, &guest_id),
            ClientMessage::HostPause { paused } => self.set_paused(conn, paused),
        }
    }

    fn on_bad_message(&self, conn: ConnId) -> Outcome {
        self.send(
            conn,
            &ServerMessage::error("BAD_MESSAGE", "Malformed message."),
        );
        Outcome::default()
    }

    fn on_failed_join(&mut self, conn: ConnId) -> Outcome {
        let count = self.failed_joins.entry(conn).or_insert(0);
        *count += 1;
        if *count >= MAX_FAILED_JOINS {
            return Outcome {
                close: Some((1008, "too many failed joins")),
            };
        }
        Outcome::default()
    }

    fn create_session(&mut self, conn: ConnId) -> Outcome {
        if self.roles.contains_key(&conn) {
            self.send(
                conn,
                &ServerMessage::error(
                    "ALREADY_IN_SESSION",
                    "This connection already belongs to a session.",
                ),
            );
            return Outcome::default();
        }
        let code = self.generate_code();
        self.sessions.insert(
            code.clone(),
            Session {
                host: conn,
                guests: HashMap::new(),
                paused: false,
                next_guest_number: 1,
            },
        );
        self.roles.insert(conn, Role::Host { code: code.clone() });
        self.send(conn, &ServerMessage::SessionCreated { code });
        self.send(
            conn,
            &ServerMessage::InjectorStatus {
                available: self.injection_available(),
            },
        );
        Outcome::default()
    }

    fn join_session(&mut self, conn: ConnId, code: &str, name: Option<&str>) -> Outcome {
        if self.roles.contains_key(&conn) {
            self.send(
                conn,
                &ServerMessage::error(
                    "ALREADY_IN_SESSION",
                    "This connection already belongs to a session.",
                ),
            );
            return Outcome::default();
        }
        let code = code.to_uppercase();
        let injection = self.injection_available();
        let Some(session) = self.sessions.get_mut(&code) else {
            self.send(
                conn,
                &ServerMessage::error(
                    "BAD_CODE",
                    "No session with that code. Check it and try again.",
                ),
            );
            return self.on_failed_join(conn);
        };
        if session.guests.len() >= MAX_GUESTS {
            self.send(
                conn,
                &ServerMessage::error("SESSION_FULL", "This session is full."),
            );
            return self.on_failed_join(conn);
        }
        let number = session.next_guest_number;
        session.next_guest_number += 1;
        let guest_id = format!("g{number}");
        let guest_name = sanitize_guest_name(name, &format!("Guest {number}"));
        session.guests.insert(
            guest_id.clone(),
            Guest {
                control: true,
                conn,
                pressed_keys: HashSet::new(),
                pressed_buttons: HashSet::new(),
                wheel_remainder: (0.0, 0.0),
            },
        );
        let host = session.host;
        let paused = session.paused;
        self.roles.insert(
            conn,
            Role::Guest {
                code: code.clone(),
                guest_id: guest_id.clone(),
            },
        );
        self.send(
            conn,
            &ServerMessage::GuestJoined {
                guest_id: guest_id.clone(),
                name: guest_name.clone(),
                control: true,
                paused,
            },
        );
        self.send(
            conn,
            &ServerMessage::InjectorStatus {
                available: injection,
            },
        );
        self.send(
            host,
            &ServerMessage::GuestConnected {
                guest: GuestInfo {
                    id: guest_id,
                    name: guest_name,
                    control: true,
                },
            },
        );
        Outcome::default()
    }

    fn route_signal(&mut self, conn: ConnId, to: Option<&str>, data: Value) -> Outcome {
        let Some(role) = self.roles.get(&conn) else {
            self.send(
                conn,
                &ServerMessage::error(
                    "NOT_IN_SESSION",
                    "Join or create a session before signaling.",
                ),
            );
            return Outcome::default();
        };
        if data.to_string().len() > MAX_SIGNAL_BYTES {
            return self.on_bad_message(conn);
        }
        match role {
            Role::Host { code } => {
                let Some(to) = to else {
                    return self.on_bad_message(conn);
                };
                let Some(session) = self.sessions.get(code) else {
                    return Outcome::default();
                };
                if let Some(guest) = session.guests.get(to) {
                    let guest_conn = guest.conn;
                    self.send(
                        guest_conn,
                        &ServerMessage::Signal {
                            from: "host".to_string(),
                            data,
                        },
                    );
                }
            }
            Role::Guest { code, guest_id } => {
                if let Some(session) = self.sessions.get(code) {
                    let host = session.host;
                    self.send(
                        host,
                        &ServerMessage::Signal {
                            from: guest_id.clone(),
                            data,
                        },
                    );
                }
            }
        }
        Outcome::default()
    }

    fn handle_input(&mut self, conn: ConnId, ev: InputEvent) -> Outcome {
        if !ev.is_valid() {
            return self.on_bad_message(conn);
        }
        let Some(Role::Guest { code, guest_id }) = self.roles.get(&conn) else {
            return Outcome::default();
        };
        let (code, guest_id) = (code.clone(), guest_id.clone());
        if !self.injection_available() {
            return Outcome::default();
        }
        let Some(session) = self.sessions.get_mut(&code) else {
            return Outcome::default();
        };
        if session.paused {
            return Outcome::default();
        }
        let Some(guest) = session.guests.get_mut(&guest_id) else {
            return Outcome::default();
        };
        if !guest.control {
            return Outcome::default();
        }

        match ev {
            InputEvent::Move { x, y } => self.injector.send(InjectCmd::Move { x, y }),
            InputEvent::Down { x, y, button } => {
                self.injector.send(InjectCmd::Move { x, y });
                self.injector.send(InjectCmd::Button { button, down: true });
                guest.pressed_buttons.insert(button);
            }
            InputEvent::Up { button } => {
                self.injector.send(InjectCmd::Button {
                    button,
                    down: false,
                });
                guest.pressed_buttons.remove(&button);
            }
            InputEvent::Wheel { dx, dy } => {
                let (rx, ry) = &mut guest.wheel_remainder;
                *rx += dx.clamp(-25.0, 25.0);
                *ry += dy.clamp(-25.0, 25.0);
                let nx = rx.trunc();
                let ny = ry.trunc();
                if nx != 0.0 || ny != 0.0 {
                    *rx -= nx;
                    *ry -= ny;
                    self.injector.send(InjectCmd::Scroll {
                        dx: nx as i32,
                        dy: ny as i32,
                    });
                }
            }
            InputEvent::Key { key, down } => {
                self.injector.send(InjectCmd::Key {
                    key: key.clone(),
                    down,
                });
                if down {
                    guest.pressed_keys.insert(key);
                } else {
                    guest.pressed_keys.remove(&key);
                }
            }
        }
        Outcome::default()
    }

    /// Release everything a guest is holding so keys never stick on the host.
    fn release_inputs(injector: &Injector, guest: &mut Guest) {
        for key in guest.pressed_keys.drain() {
            injector.send(InjectCmd::Key { key, down: false });
        }
        for button in guest.pressed_buttons.drain() {
            injector.send(InjectCmd::Button {
                button,
                down: false,
            });
        }
    }

    fn require_host_code(&self, conn: ConnId) -> Option<String> {
        match self.roles.get(&conn) {
            Some(Role::Host { code }) => Some(code.clone()),
            _ => {
                self.send(
                    conn,
                    &ServerMessage::error("NOT_HOST", "Only the session host can do that."),
                );
                None
            }
        }
    }

    fn set_guest_control(&mut self, conn: ConnId, guest_id: &str, control: bool) -> Outcome {
        let Some(code) = self.require_host_code(conn) else {
            return Outcome::default();
        };
        let injector = self.injector.clone();
        let (guest_conn, paused) = {
            let Some(session) = self.sessions.get_mut(&code) else {
                return Outcome::default();
            };
            let paused = session.paused;
            let Some(guest) = session.guests.get_mut(guest_id) else {
                return Outcome::default();
            };
            guest.control = control;
            if !control {
                Self::release_inputs(&injector, guest);
            }
            (guest.conn, paused)
        };
        self.send(
            guest_conn,
            &ServerMessage::ControlChanged { control, paused },
        );
        Outcome::default()
    }

    fn set_paused(&mut self, conn: ConnId, paused: bool) -> Outcome {
        let Some(code) = self.require_host_code(conn) else {
            return Outcome::default();
        };
        let injector = self.injector.clone();
        let mut notify: Vec<(ConnId, bool)> = Vec::new();
        if let Some(session) = self.sessions.get_mut(&code) {
            session.paused = paused;
            for guest in session.guests.values_mut() {
                if paused {
                    Self::release_inputs(&injector, guest);
                }
                notify.push((guest.conn, guest.control));
            }
        }
        for (guest_conn, control) in notify {
            self.send(
                guest_conn,
                &ServerMessage::ControlChanged { control, paused },
            );
        }
        Outcome::default()
    }

    fn kick_guest(&mut self, conn: ConnId, guest_id: &str) -> Outcome {
        let Some(code) = self.require_host_code(conn) else {
            return Outcome::default();
        };
        let injector = self.injector.clone();
        // Synchronously tear down state so a hostile client can't keep injecting
        // between the kick and the socket actually closing.
        let (guest_conn, host) = {
            let Some(session) = self.sessions.get_mut(&code) else {
                return Outcome::default();
            };
            let Some(mut guest) = session.guests.remove(guest_id) else {
                return Outcome::default();
            };
            Self::release_inputs(&injector, &mut guest);
            (guest.conn, session.host)
        };
        self.roles.remove(&guest_conn);
        self.failed_joins.remove(&guest_conn);
        self.send(
            host,
            &ServerMessage::GuestDisconnected {
                guest_id: guest_id.to_string(),
            },
        );
        // Ask the guest's own connection task to close its socket.
        if let Some(tx) = self.senders.get(&guest_conn) {
            let _ = tx.send(kick_sentinel());
        }
        Outcome::default()
    }

    /// Called when a connection's socket closes. Cleans up its role.
    pub fn remove_connection(&mut self, conn: ConnId) {
        self.senders.remove(&conn);
        self.failed_joins.remove(&conn);
        let injector = self.injector.clone();
        let Some(role) = self.roles.remove(&conn) else {
            return;
        };
        match role {
            Role::Host { code } => {
                if let Some(mut session) = self.sessions.remove(&code) {
                    for guest in session.guests.values_mut() {
                        Self::release_inputs(&injector, guest);
                        self.roles.remove(&guest.conn);
                        self.send(guest.conn, &ServerMessage::SessionEnded);
                        if let Some(tx) = self.senders.get(&guest.conn) {
                            let _ = tx.send(session_ended_sentinel());
                        }
                    }
                }
            }
            Role::Guest { code, guest_id } => {
                if let Some(session) = self.sessions.get_mut(&code) {
                    if let Some(mut guest) = session.guests.remove(&guest_id) {
                        Self::release_inputs(&injector, &mut guest);
                    }
                    let host = session.host;
                    self.send(host, &ServerMessage::GuestDisconnected { guest_id });
                }
            }
        }
    }

    fn generate_code(&self) -> String {
        // ThreadRng is a CSPRNG, so codes are unguessable.
        let mut rng = rand::rng();
        loop {
            let code: String = (0..SESSION_CODE_LENGTH)
                .map(|_| {
                    let idx = rng.random_range(0..SESSION_CODE_ALPHABET.len());
                    SESSION_CODE_ALPHABET[idx] as char
                })
                .collect();
            if !self.sessions.contains_key(&code) {
                return code;
            }
        }
    }
}

/// Sentinel frames the connection task recognizes as "close now". These are not
/// valid JSON protocol messages, so they can never collide with a real frame.
pub fn kick_sentinel() -> String {
    format!("\u{0}close:{CLOSE_KICKED}")
}

pub fn session_ended_sentinel() -> String {
    format!("\u{0}close:{CLOSE_SESSION_ENDED}")
}

pub fn parse_close_sentinel(frame: &str) -> Option<u16> {
    frame
        .strip_prefix("\u{0}close:")
        .and_then(|c| c.parse().ok())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hub() -> Hub {
        Hub::new(Injector::disabled_for_tests())
    }

    #[test]
    fn creates_a_session_with_a_valid_code() {
        let mut h = hub();
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        h.add_connection(1, tx);
        h.handle_text(1, r#"{"t":"host:create"}"#);
        let created = rx.try_recv().unwrap();
        assert!(created.contains("session:created"));
    }

    #[test]
    fn rejects_unknown_join_code() {
        let mut h = hub();
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        h.add_connection(1, tx);
        h.handle_text(1, r#"{"t":"guest:join","code":"ZZZZZZ"}"#);
        assert!(rx.try_recv().unwrap().contains("BAD_CODE"));
    }

    #[test]
    fn repeated_bad_codes_request_close() {
        let mut h = hub();
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        h.add_connection(1, tx);
        let mut closed = false;
        for _ in 0..MAX_FAILED_JOINS {
            let outcome = h.handle_text(1, r#"{"t":"guest:join","code":"ZZZZZZ"}"#);
            closed = closed || outcome.close.is_some();
        }
        assert!(closed);
    }

    #[test]
    fn relays_signaling_and_pairs_guest() {
        let mut h = hub();
        let (htx, mut hrx) = tokio::sync::mpsc::unbounded_channel();
        h.add_connection(1, htx);
        h.handle_text(1, r#"{"t":"host:create"}"#);
        let created: Value = serde_json::from_str(&hrx.try_recv().unwrap()).unwrap();
        let code = created["code"].as_str().unwrap().to_string();
        let _ = hrx.try_recv(); // injector:status

        let (gtx, mut grx) = tokio::sync::mpsc::unbounded_channel();
        h.add_connection(2, gtx);
        h.handle_text(2, &format!(r#"{{"t":"guest:join","code":"{code}"}}"#));
        assert!(grx.try_recv().unwrap().contains("guest:joined"));
        let _ = grx.try_recv(); // injector:status
        assert!(hrx.try_recv().unwrap().contains("guest:connected"));

        h.handle_text(1, r#"{"t":"signal","to":"g1","data":{"sdp":"x"}}"#);
        assert!(grx.try_recv().unwrap().contains("\"from\":\"host\""));
    }
}
