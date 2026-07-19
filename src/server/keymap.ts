/**
 * Maps browser `KeyboardEvent.key` values to robotjs key names.
 *
 * robotjs can only toggle a fixed set of named keys plus ASCII letters and
 * digits. Printable characters outside that set (punctuation, accented
 * letters) are injected as literal text on key-down instead, which types the
 * character but cannot participate in held-key shortcuts — an acceptable
 * trade-off documented in the README.
 */

export type MappedKey = { type: 'toggle'; key: string } | { type: 'text'; text: string };

const SPECIAL_KEYS: Record<string, string> = {
  ' ': 'space',
  Alt: 'alt',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ArrowUp: 'up',
  Backspace: 'backspace',
  Control: 'control',
  Delete: 'delete',
  End: 'end',
  Enter: 'enter',
  Escape: 'escape',
  Home: 'home',
  Insert: 'insert',
  Meta: 'command',
  PageDown: 'pagedown',
  PageUp: 'pageup',
  Shift: 'shift',
  Tab: 'tab',
};

for (let i = 1; i <= 24; i++) {
  SPECIAL_KEYS[`F${i}`] = `f${i}`;
}

/** Map a `KeyboardEvent.key` to an injectable action, or null to drop it. */
export function mapKey(key: string): MappedKey | null {
  // Own-property check only: a bare `SPECIAL_KEYS[key]` would also resolve
  // inherited members like "constructor" or "toString" to functions, which
  // would then be handed to the native injector and throw.
  const special = Object.hasOwn(SPECIAL_KEYS, key) ? SPECIAL_KEYS[key] : undefined;
  if (special) return { type: 'toggle', key: special };
  if (key.length !== 1) return null;
  if (/^[a-zA-Z0-9]$/.test(key)) return { type: 'toggle', key: key.toLowerCase() };
  // Any other single printable character (punctuation, accented letters, …).
  return { type: 'text', text: key };
}
