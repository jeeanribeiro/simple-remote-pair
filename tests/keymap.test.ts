import { describe, expect, it } from 'vitest';
import { mapKey } from '../src/server/keymap.js';

describe('mapKey', () => {
  it('maps special keys to robotjs names', () => {
    expect(mapKey('ArrowUp')).toEqual({ type: 'toggle', key: 'up' });
    expect(mapKey('Enter')).toEqual({ type: 'toggle', key: 'enter' });
    expect(mapKey('Meta')).toEqual({ type: 'toggle', key: 'command' });
    expect(mapKey(' ')).toEqual({ type: 'toggle', key: 'space' });
    expect(mapKey('F12')).toEqual({ type: 'toggle', key: 'f12' });
    expect(mapKey('F24')).toEqual({ type: 'toggle', key: 'f24' });
  });

  it('lowercases letters so shift produces capitals on the host', () => {
    expect(mapKey('A')).toEqual({ type: 'toggle', key: 'a' });
    expect(mapKey('z')).toEqual({ type: 'toggle', key: 'z' });
    expect(mapKey('7')).toEqual({ type: 'toggle', key: '7' });
  });

  it('routes punctuation and accented characters through text injection', () => {
    expect(mapKey('.')).toEqual({ type: 'text', text: '.' });
    expect(mapKey('?')).toEqual({ type: 'text', text: '?' });
    expect(mapKey('é')).toEqual({ type: 'text', text: 'é' });
  });

  it('drops keys that cannot be injected', () => {
    expect(mapKey('CapsLock')).toBeNull();
    expect(mapKey('Dead')).toBeNull();
    expect(mapKey('Unidentified')).toBeNull();
    expect(mapKey('MediaPlayPause')).toBeNull();
  });

  it('does not resolve inherited Object.prototype members', () => {
    // A bare property lookup would return functions for these, which the
    // native injector would then choke on.
    expect(mapKey('constructor')).toBeNull();
    expect(mapKey('toString')).toBeNull();
    expect(mapKey('hasOwnProperty')).toBeNull();
    expect(mapKey('valueOf')).toBeNull();
    expect(mapKey('__proto__')).toBeNull();
  });
});
