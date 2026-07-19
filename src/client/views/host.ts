import { renderSVG } from 'uqr';
import type { GuestInfo, ServerMessage } from '../../shared/protocol.js';
import { copyText, el, toast } from '../lib/dom.js';
import { HostPeers } from '../lib/rtc.js';
import { RemoteSocket } from '../lib/socket.js';

interface GuestRow {
  info: GuestInfo;
  row: HTMLLIElement;
}

/** Host view: create a session, share the screen, manage guests. */
export function renderHost(root: HTMLElement): () => void {
  let socket: RemoteSocket | null = null;
  let peers: HostPeers | null = null;
  let stream: MediaStream | null = null;
  let ended = false;
  const guests = new Map<string, GuestRow>();

  const codeEl = el('output', { class: 'session-code', 'aria-label': 'Session code' }, '······');
  const qrBox = el('div', { class: 'qr', 'aria-hidden': 'true' });
  const linkText = el('span', { class: 'join-link-text' }, '…');
  const copyLinkBtn = el(
    'button',
    {
      class: 'btn btn-ghost',
      onclick: async () => {
        const ok = await copyText(linkText.textContent ?? '');
        toast(
          ok ? 'Join link copied.' : 'Could not copy — select the link text instead.',
          ok ? 'info' : 'error',
        );
      },
    },
    'Copy link',
  );

  const preview = el('video', {
    class: 'preview',
    autoplay: true,
    muted: true,
    playsinline: true,
    'aria-label': 'Preview of your shared screen',
  });
  preview.muted = true;

  const shareBtn = el('button', { class: 'btn btn-primary btn-lg' }, 'Start sharing screen');
  const shareState = el('p', { class: 'hint', role: 'status' }, 'Nothing shared yet.');

  const guestList = el('ul', { class: 'guest-list' });
  const guestEmpty = el('p', { class: 'hint' }, 'No guests yet — share the code or link.');
  const guestCount = el('span', { class: 'count-badge' }, '0');

  const pauseToggle = el('input', { type: 'checkbox', id: 'pause-toggle', class: 'switch' });
  const controlHint = el('p', { class: 'hint hidden', role: 'status' });

  function joinUrl(code: string): string {
    // The desktop (Tauri) build loads this window on localhost for a secure
    // context (getDisplayMedia), but guests must reach the LAN address — the
    // server injects that as __srpPublicBase__. The browser build has no such
    // global and falls back to its own origin, which is already the LAN URL.
    const base =
      (window as { __srpPublicBase__?: string }).__srpPublicBase__ ??
      `${location.origin}${location.pathname}`;
    return `${base}#/join/${code}`;
  }

  function updateGuestCount(): void {
    guestCount.textContent = String(guests.size);
    guestEmpty.classList.toggle('hidden', guests.size > 0);
  }

  function addGuestRow(info: GuestInfo): void {
    const controlSwitch = el('input', {
      type: 'checkbox',
      class: 'switch',
      'aria-label': `Allow ${info.name} to control`,
    }) as HTMLInputElement;
    controlSwitch.checked = info.control;
    controlSwitch.addEventListener('change', () => {
      socket?.send({ t: 'host:control', guestId: info.id, control: controlSwitch.checked });
    });
    const row = el(
      'li',
      { class: 'guest-row' },
      el('span', { class: 'guest-name' }, info.name),
      el('label', { class: 'switch-label' }, controlSwitch, el('span', {}, 'control')),
      el(
        'button',
        {
          class: 'btn btn-danger btn-sm',
          onclick: () => socket?.send({ t: 'host:kick', guestId: info.id }),
          'aria-label': `Remove ${info.name}`,
        },
        'Remove',
      ),
    );
    guests.set(info.id, { info, row });
    guestList.append(row);
    updateGuestCount();
  }

  async function startSharing(): Promise<void> {
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 60 } },
        audio: true,
      });
    } catch {
      toast('Screen sharing was cancelled.', 'error');
      return;
    }
    preview.srcObject = stream;
    preview.classList.add('visible');
    peers?.setStream(stream);
    shareBtn.textContent = 'Stop sharing';
    shareState.textContent = 'Sharing your screen with all guests.';
    // The browser's own "stop sharing" bar also lands here.
    stream.getVideoTracks()[0]?.addEventListener('ended', stopSharing);
  }

  function stopSharing(): void {
    if (!stream) return;
    for (const track of stream.getTracks()) track.stop();
    stream = null;
    preview.srcObject = null;
    preview.classList.remove('visible');
    peers?.setStream(null);
    shareBtn.textContent = 'Start sharing screen';
    shareState.textContent = 'Sharing stopped.';
  }

  shareBtn.addEventListener('click', () => {
    if (stream) stopSharing();
    else void startSharing();
  });

  pauseToggle.addEventListener('change', () => {
    socket?.send({ t: 'host:pause', paused: (pauseToggle as HTMLInputElement).checked });
  });

  function onMessage(message: ServerMessage): void {
    switch (message.t) {
      case 'session:created': {
        codeEl.textContent = message.code;
        const url = joinUrl(message.code);
        linkText.textContent = url;
        qrBox.innerHTML = renderSVG(url, { border: 1 });
        break;
      }
      case 'injector:status':
        controlHint.classList.toggle('hidden', message.available);
        if (!message.available) {
          controlHint.textContent =
            'Remote control is unavailable on this server — guests can watch but not drive.';
        }
        break;
      case 'guest:connected':
        addGuestRow(message.guest);
        peers?.addGuest(message.guest.id);
        toast(`${message.guest.name} joined.`);
        break;
      case 'guest:disconnected': {
        const entry = guests.get(message.guestId);
        if (entry) {
          entry.row.remove();
          guests.delete(message.guestId);
          peers?.removeGuest(message.guestId);
          toast(`${entry.info.name} left.`);
          updateGuestCount();
        }
        break;
      }
      case 'signal':
        void peers?.handleSignal(message.from, message.data);
        break;
      case 'error':
        toast(message.message, 'error');
        break;
      default:
        break;
    }
  }

  root.append(
    el(
      'main',
      { class: 'host' },
      el(
        'header',
        { class: 'view-header' },
        el('a', { class: 'wordmark wordmark-sm', href: '#/' }, 'simple remote pair'),
        el('span', { class: 'pill' }, 'Hosting'),
        el(
          'button',
          {
            class: 'btn btn-danger',
            onclick: () => {
              location.hash = '#/';
            },
          },
          'End session',
        ),
      ),
      el(
        'div',
        { class: 'host-grid' },
        el(
          'section',
          { class: 'card', 'aria-labelledby': 'invite-title' },
          el('h2', { id: 'invite-title' }, 'Invite guests'),
          codeEl,
          el('div', { class: 'join-link' }, linkText, copyLinkBtn),
          qrBox,
        ),
        el(
          'section',
          { class: 'card', 'aria-labelledby': 'share-title' },
          el('h2', { id: 'share-title' }, 'Your screen'),
          shareBtn,
          shareState,
          controlHint,
          preview,
          el(
            'p',
            { class: 'hint' },
            'For remote control to line up, share your entire primary display.',
          ),
        ),
        el(
          'section',
          { class: 'card', 'aria-labelledby': 'guests-title' },
          el(
            'div',
            { class: 'card-title-row' },
            el('h2', { id: 'guests-title' }, 'Guests ', guestCount),
            el(
              'label',
              { class: 'switch-label' },
              pauseToggle,
              el('span', {}, 'Pause all control'),
            ),
          ),
          guestEmpty,
          guestList,
        ),
      ),
    ),
  );

  RemoteSocket.connect({
    onMessage,
    onClose: () => {
      if (ended) return;
      toast('Lost connection to the server — session ended.', 'error');
      location.hash = '#/';
    },
  })
    .then((s) => {
      if (ended) {
        s.close();
        return;
      }
      socket = s;
      peers = new HostPeers(s);
      s.send({ t: 'host:create' });
      // If the user started sharing before the socket connected, the stream
      // was dropped on the floor (peers was null); replay it now.
      if (stream) peers.setStream(stream);
    })
    .catch(() => {
      if (ended) return;
      toast('Could not reach the server.', 'error');
      location.hash = '#/';
    });

  return () => {
    ended = true;
    stopSharing();
    peers?.closeAll();
    socket?.close();
  };
}
