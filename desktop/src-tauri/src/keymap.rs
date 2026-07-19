//! Maps browser `KeyboardEvent.key` values to `enigo` keys.
//!
//! Named keys map to dedicated `enigo::Key` variants; ASCII letters/digits map
//! to `Key::Unicode`; any other single printable character is injected as text
//! on key-down (mirroring the Node server's behavior).

use enigo::Key;

pub enum MappedKey {
    Toggle(Key),
    Text(String),
}

pub fn map_key(key: &str) -> Option<MappedKey> {
    if let Some(named) = named_key(key) {
        return Some(MappedKey::Toggle(named));
    }
    let mut chars = key.chars();
    let (Some(ch), None) = (chars.next(), chars.next()) else {
        return None; // multi-char name we don't recognize
    };
    if ch.is_ascii_alphanumeric() {
        Some(MappedKey::Toggle(Key::Unicode(ch.to_ascii_lowercase())))
    } else {
        Some(MappedKey::Text(ch.to_string()))
    }
}

fn named_key(key: &str) -> Option<Key> {
    let k = match key {
        " " => Key::Space,
        "Alt" => Key::Alt,
        "ArrowDown" => Key::DownArrow,
        "ArrowLeft" => Key::LeftArrow,
        "ArrowRight" => Key::RightArrow,
        "ArrowUp" => Key::UpArrow,
        "Backspace" => Key::Backspace,
        "Control" => Key::Control,
        "Delete" => Key::Delete,
        "End" => Key::End,
        "Enter" => Key::Return,
        "Escape" => Key::Escape,
        "Home" => Key::Home,
        "Insert" => Key::Insert,
        "Meta" => Key::Meta,
        "PageDown" => Key::PageDown,
        "PageUp" => Key::PageUp,
        "Shift" => Key::Shift,
        "Tab" => Key::Tab,
        "F1" => Key::F1,
        "F2" => Key::F2,
        "F3" => Key::F3,
        "F4" => Key::F4,
        "F5" => Key::F5,
        "F6" => Key::F6,
        "F7" => Key::F7,
        "F8" => Key::F8,
        "F9" => Key::F9,
        "F10" => Key::F10,
        "F11" => Key::F11,
        "F12" => Key::F12,
        _ => return None,
    };
    Some(k)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_named_and_alnum_keys() {
        assert!(matches!(
            map_key("Enter"),
            Some(MappedKey::Toggle(Key::Return))
        ));
        assert!(matches!(map_key(" "), Some(MappedKey::Toggle(Key::Space))));
        assert!(matches!(
            map_key("A"),
            Some(MappedKey::Toggle(Key::Unicode('a')))
        ));
    }

    #[test]
    fn routes_punctuation_to_text() {
        assert!(matches!(map_key("."), Some(MappedKey::Text(_))));
        assert!(matches!(map_key("é"), Some(MappedKey::Text(_))));
    }

    #[test]
    fn drops_uninjectable_keys() {
        assert!(map_key("CapsLock").is_none());
        assert!(map_key("Unidentified").is_none());
    }
}
