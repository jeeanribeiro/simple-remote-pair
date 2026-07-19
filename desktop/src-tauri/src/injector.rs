//! OS input injection on a dedicated thread.
//!
//! `enigo` is not `Send` on every platform and some backends want a single
//! owning thread, so the injector runs on its own std thread and receives
//! commands over a channel. Normalized coordinates are converted to pixels
//! here, against the primary display size.

use std::sync::mpsc::{self, Sender};
use std::thread;

use enigo::{Axis, Button, Coordinate, Direction, Enigo, Keyboard, Mouse, Settings};

use crate::keymap::{map_key, MappedKey};
use crate::protocol::MouseButton;

/// Wheel notch multiplier: platforms differ in what one `scroll` step means.
#[cfg(target_os = "windows")]
const SCROLL_STEP: i32 = 1;
#[cfg(not(target_os = "windows"))]
const SCROLL_STEP: i32 = 1;

pub enum InjectCmd {
    /// Normalized [0, 1] coordinates.
    Move {
        x: f64,
        y: f64,
    },
    Button {
        button: MouseButton,
        down: bool,
    },
    /// Whole wheel notches; positive dy scrolls up.
    Scroll {
        dx: i32,
        dy: i32,
    },
    Key {
        key: String,
        down: bool,
    },
}

#[derive(Clone)]
pub struct Injector {
    tx: Option<Sender<InjectCmd>>,
}

impl Injector {
    /// Spawn the injector thread. Returns a disabled injector (view-only) if the
    /// backend can't initialize (e.g. headless CI, missing permissions).
    pub fn spawn() -> Self {
        let (tx, rx) = mpsc::channel::<InjectCmd>();
        let ready = match Enigo::new(&Settings::default()) {
            Ok(mut enigo) => thread::Builder::new()
                .name("srp-injector".into())
                .spawn(move || run(&mut enigo, rx))
                .is_ok(),
            Err(_) => false,
        };
        Injector {
            tx: if ready { Some(tx) } else { None },
        }
    }

    /// A disabled injector — reports unavailable and drops every command.
    /// Used by hub unit tests so they never move the real mouse.
    #[cfg(test)]
    pub fn disabled_for_tests() -> Self {
        Injector { tx: None }
    }

    pub fn available(&self) -> bool {
        self.tx.is_some()
    }

    pub fn send(&self, cmd: InjectCmd) {
        if let Some(tx) = &self.tx {
            let _ = tx.send(cmd);
        }
    }
}

fn run(enigo: &mut Enigo, rx: mpsc::Receiver<InjectCmd>) {
    let mut size = enigo.main_display().unwrap_or((1, 1));
    let mut since_refresh = 0u32;

    while let Ok(cmd) = rx.recv() {
        // Refresh the display size occasionally so resolution changes are picked
        // up without querying on every single move.
        since_refresh += 1;
        if since_refresh >= 240 {
            since_refresh = 0;
            if let Ok(s) = enigo.main_display() {
                size = s;
            }
        }

        match cmd {
            InjectCmd::Move { x, y } => {
                let (px, py) = to_pixels(x, y, size);
                let _ = enigo.move_mouse(px, py, Coordinate::Abs);
            }
            InjectCmd::Button { button, down } => {
                let _ = enigo.button(map_button(button), direction(down));
            }
            InjectCmd::Scroll { dx, dy } => {
                if dx != 0 {
                    let _ = enigo.scroll(dx * SCROLL_STEP, Axis::Horizontal);
                }
                if dy != 0 {
                    // enigo scrolls down for positive; our notches are up-positive.
                    let _ = enigo.scroll(-dy * SCROLL_STEP, Axis::Vertical);
                }
            }
            InjectCmd::Key { key, down } => match map_key(&key) {
                Some(MappedKey::Toggle(k)) => {
                    let _ = enigo.key(k, direction(down));
                }
                Some(MappedKey::Text(text)) => {
                    if down {
                        let _ = enigo.text(&text);
                    }
                }
                None => {}
            },
        }
    }
}

fn to_pixels(x: f64, y: f64, (w, h): (i32, i32)) -> (i32, i32) {
    let px = (x * f64::from((w - 1).max(0))).round() as i32;
    let py = (y * f64::from((h - 1).max(0))).round() as i32;
    (px, py)
}

fn map_button(button: MouseButton) -> Button {
    match button {
        1 => Button::Middle,
        2 => Button::Right,
        _ => Button::Left,
    }
}

fn direction(down: bool) -> Direction {
    if down {
        Direction::Press
    } else {
        Direction::Release
    }
}
