import { isSessionCode, SESSION_CODE_LENGTH } from '../../shared/protocol.js';
import { el } from '../lib/dom.js';

/** Landing view: choose to host or join with a code. */
export function renderHome(root: HTMLElement): () => void {
  const codeInput = el('input', {
    class: 'input code-input',
    id: 'join-code',
    name: 'code',
    autocomplete: 'off',
    spellcheck: 'false',
    maxlength: String(SESSION_CODE_LENGTH),
    placeholder: 'ABC123',
    'aria-describedby': 'join-hint',
  });
  const joinButton = el(
    'button',
    { class: 'btn btn-primary', type: 'submit', disabled: true },
    'Join session',
  );

  codeInput.addEventListener('input', () => {
    codeInput.value = codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    joinButton.disabled = !isSessionCode(codeInput.value);
  });

  const nameInput = el('input', {
    class: 'input',
    id: 'join-name',
    name: 'name',
    autocomplete: 'nickname',
    maxlength: '24',
    placeholder: 'Optional',
  });
  nameInput.value = sessionStorage.getItem('srp-name') ?? '';

  const joinForm = el(
    'form',
    {
      class: 'join-form',
      onsubmit: (event: Event) => {
        event.preventDefault();
        if (!isSessionCode(codeInput.value)) return;
        const name = nameInput.value.trim();
        if (name) sessionStorage.setItem('srp-name', name);
        else sessionStorage.removeItem('srp-name');
        location.hash = `#/join/${codeInput.value}`;
      },
    },
    el('label', { class: 'label', for: 'join-code' }, 'Session code'),
    codeInput,
    el('p', { class: 'hint', id: 'join-hint' }, 'Ask the host for their 6-character code.'),
    el('label', { class: 'label', for: 'join-name' }, 'Your name'),
    nameInput,
    joinButton,
  );

  root.append(
    el(
      'main',
      { class: 'home' },
      el(
        'header',
        { class: 'home-hero' },
        el('h1', { class: 'wordmark' }, 'simple remote pair'),
        el(
          'p',
          { class: 'tagline' },
          'Share your screen and hand over mouse & keyboard — peer-to-peer on your LAN or VPN. No cloud, no accounts.',
        ),
      ),
      el(
        'div',
        { class: 'home-cards' },
        el(
          'section',
          { class: 'card', 'aria-labelledby': 'host-title' },
          el('h2', { id: 'host-title' }, 'Host a session'),
          el('p', {}, 'Stream this machine’s screen and let guests drive it.'),
          el(
            'button',
            {
              class: 'btn btn-primary',
              onclick: () => {
                location.hash = '#/host';
              },
            },
            'Start hosting',
          ),
        ),
        el(
          'section',
          { class: 'card', 'aria-labelledby': 'join-title' },
          el('h2', { id: 'join-title' }, 'Join a session'),
          joinForm,
        ),
      ),
      el(
        'footer',
        { class: 'home-footer' },
        el(
          'a',
          { href: 'https://github.com/jeeanribeiro/simple-remote-pair', rel: 'noreferrer' },
          'GitHub',
        ),
        el('span', { 'aria-hidden': 'true' }, '·'),
        el('span', {}, 'For trusted networks only'),
      ),
    ),
  );

  return () => {};
}
