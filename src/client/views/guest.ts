import type { ServerMessage } from '../../shared/protocol.js';
import { InputCapture } from '../lib/capture.js';
import { el, toast } from '../lib/dom.js';
import { GuestPeer } from '../lib/rtc.js';
import { RemoteSocket } from '../lib/socket.js';
import { type StreamStats, watchStats } from '../lib/stats.js';

const CLOSE_KICKED = 4001;
const CLOSE_SESSION_ENDED = 4002;
const REJOIN_DELAYS_MS = [1000, 2000, 4000];

interface GuestState {
  control: boolean;
  paused: boolean;
  injectorAvailable: boolean;
  hasStream: boolean;
}

/** Guest view: join with a code, watch the stream, optionally take control. */
export function renderGuest(root: HTMLElement, code: string): () => void {
  let socket: RemoteSocket | null = null;
  let peer: GuestPeer | null = null;
  let capture: InputCapture | null = null;
  let stopStats: (() => void) | null = null;
  let leaving = false;
  let joined = false;
  let rejoinAttempt = 0;
  let rejoinTimer: ReturnType<typeof setTimeout> | null = null;

  const state: GuestState = {
    control: false,
    paused: false,
    injectorAvailable: false,
    hasStream: false,
  };

  const video = el('video', {
    class: 'remote-video',
    autoplay: true,
    playsinline: true,
    'aria-label': 'Remote screen',
  });
  const stage = el(
    'div',
    {
      class: 'stage',
      tabindex: '0',
      role: 'application',
      'aria-roledescription': 'remote screen',
      'aria-label':
        'Remote screen. Click or press Enter to take control; press Escape twice to release.',
    },
    video,
  );
  const statusPill = el('span', { class: 'pill', role: 'status' }, 'Connecting…');
  const controlPill = el('button', { class: 'pill pill-action hidden' }, '');
  const statsBadge = el('span', { class: 'stats-badge', 'aria-label': 'Stream statistics' }, '');
  const announcer = el('p', { class: 'sr-only', 'aria-live': 'polite' });
  const overlay = el(
    'div',
    { class: 'stage-overlay' },
    el('p', {}, 'Waiting for the host to share their screen…'),
  );

  function canControl(): boolean {
    return state.control && !state.paused && state.injectorAvailable && state.hasStream;
  }

  function announce(text: string): void {
    announcer.textContent = text;
  }

  function refreshControlUi(): void {
    const controlling = capture?.active ?? false;
    stage.classList.toggle('stage-controlling', controlling);
    controlPill.classList.toggle('hidden', !canControl() && !controlling);
    if (controlling) {
      controlPill.textContent = 'Controlling — Esc ×2 to release';
    } else if (canControl()) {
      controlPill.textContent = 'Click the screen to take control';
    }
    if (!state.injectorAvailable) {
      statusPill.textContent = state.hasStream ? 'View only' : (statusPill.textContent ?? '');
    } else if (state.paused) {
      statusPill.textContent = 'Control paused by host';
    } else if (!state.control) {
      statusPill.textContent = 'View only';
    } else if (state.hasStream) {
      statusPill.textContent = 'Live';
    }
  }

  function showStats(stats: StreamStats): void {
    const parts: string[] = [];
    if (stats.width && stats.height) parts.push(`${stats.width}×${stats.height}`);
    if (stats.fps) parts.push(`${Math.round(stats.fps)} fps`);
    if (stats.rttMs !== undefined) parts.push(`${stats.rttMs} ms`);
    statsBadge.textContent = parts.join(' · ');
  }

  function endView(message: string): void {
    capture?.dispose();
    capture = null;
    stopStats?.();
    stage.replaceChildren(
      el(
        'div',
        { class: 'stage-end' },
        el('p', {}, message),
        el('a', { class: 'btn btn-primary', href: '#/' }, 'Back to start'),
      ),
    );
    statusPill.textContent = 'Disconnected';
    announce(message);
  }

  function takeControl(): void {
    if (canControl() && capture && !capture.active) {
      capture.enable();
      announce('You are controlling the remote screen. Press Escape twice to release.');
      refreshControlUi();
    }
  }

  function setupCapture(): void {
    if (capture) return;
    capture = new InputCapture(stage, video, {
      send: (ev) => socket?.send({ t: 'input', ev }),
      onRelease: () => {
        announce('Control released.');
        refreshControlUi();
      },
    });
    stage.addEventListener('click', takeControl);
    // Keyboard path to take control: the stage is a div, so it gets no
    // synthetic click on Enter/Space. Once control is active these keys are
    // forwarded to the host instead.
    stage.addEventListener('keydown', (event) => {
      if ((event.key === 'Enter' || event.key === ' ') && !capture?.active) {
        event.preventDefault();
        takeControl();
      }
    });
    controlPill.addEventListener('click', takeControl);
  }

  // Both an unexpected close and a failed reconnect handshake land here, so a
  // rejoin attempt that can't complete still climbs the 1s/2s/4s ladder
  // instead of ending the view on the first miss.
  function scheduleRejoinOrEnd(endMessage: string): void {
    if (leaving) return;
    if (joined && rejoinAttempt < REJOIN_DELAYS_MS.length) {
      const delay = REJOIN_DELAYS_MS[rejoinAttempt++] ?? 4000;
      statusPill.textContent = 'Reconnecting…';
      announce('Connection lost, trying to reconnect.');
      rejoinTimer = setTimeout(connect, delay);
    } else {
      endView(endMessage);
    }
  }

  function connect(): void {
    RemoteSocket.connect({
      onMessage,
      onClose: (event) => {
        if (leaving) return;
        stopStats?.();
        stopStats = null;
        if (event.code === CLOSE_KICKED) return endView('The host removed you from the session.');
        if (event.code === CLOSE_SESSION_ENDED) return endView('The host ended the session.');
        scheduleRejoinOrEnd('Lost connection to the session.');
      },
    })
      .then((s) => {
        if (leaving) {
          s.close();
          return;
        }
        socket = s;
        peer?.close();
        peer = new GuestPeer(s, {
          onStream: (stream) => {
            video.srcObject = stream;
            state.hasStream = true;
            overlay.classList.add('hidden');
            stream.addEventListener('removetrack', () => {
              if (stream.getTracks().length > 0) return;
              // Host stopped sharing; keep the session, show the waiting state.
              state.hasStream = false;
              video.srcObject = null;
              overlay.classList.remove('hidden');
              capture?.release();
              refreshControlUi();
            });
            refreshControlUi();
          },
          onConnectionState: (connectionState) => {
            if (connectionState === 'connected') {
              stopStats?.();
              if (peer) stopStats = watchStats(peer.connection, showStats);
            }
          },
        });
        const name = sessionStorage.getItem('srp-name') ?? undefined;
        s.send(name ? { t: 'guest:join', code, name } : { t: 'guest:join', code });
      })
      .catch(() => scheduleRejoinOrEnd('Could not reach the server.'));
  }

  function onMessage(message: ServerMessage): void {
    switch (message.t) {
      case 'guest:joined':
        joined = true;
        rejoinAttempt = 0;
        state.control = message.control;
        state.paused = message.paused;
        statusPill.textContent = 'Waiting for stream…';
        refreshControlUi();
        break;
      case 'injector:status':
        state.injectorAvailable = message.available;
        refreshControlUi();
        break;
      case 'signal':
        void peer?.handleSignal(message.data);
        break;
      case 'control:changed': {
        const wasControlling = capture?.active ?? false;
        state.control = message.control;
        state.paused = message.paused;
        if (!canControl() && wasControlling) {
          capture?.release();
          toast(message.paused ? 'Host paused control.' : 'Host revoked your control.', 'info');
        }
        refreshControlUi();
        break;
      }
      case 'session:ended':
        // The close handler shows the final screen.
        break;
      case 'error':
        if (message.code === 'BAD_CODE' || message.code === 'SESSION_FULL') {
          leaving = true;
          socket?.close();
          endView(message.message);
        } else {
          toast(message.message, 'error');
        }
        break;
      default:
        break;
    }
  }

  const fullscreenBtn = el(
    'button',
    { class: 'btn btn-ghost', 'aria-label': 'Enter fullscreen' },
    'Fullscreen',
  );
  fullscreenBtn.addEventListener('click', async () => {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await stage.requestFullscreen();
  });
  document.addEventListener('fullscreenchange', onFullscreenChange);
  function onFullscreenChange(): void {
    const active = document.fullscreenElement === stage;
    fullscreenBtn.setAttribute('aria-label', active ? 'Exit fullscreen' : 'Enter fullscreen');
    // Keyboard Lock (Chromium): capture Tab/Alt/Cmd — even Ctrl+W — while fullscreen.
    const keyboard = (
      navigator as { keyboard?: { lock?: () => Promise<void>; unlock?: () => void } }
    ).keyboard;
    if (active) void keyboard?.lock?.().catch(() => {});
    else keyboard?.unlock?.();
  }

  setupCapture();
  connect();

  root.append(
    el(
      'main',
      { class: 'guest' },
      el(
        'header',
        { class: 'view-header' },
        el('a', { class: 'wordmark wordmark-sm', href: '#/' }, 'simple remote pair'),
        statusPill,
        controlPill,
        statsBadge,
        el('span', { class: 'spacer' }),
        fullscreenBtn,
        el(
          'button',
          {
            class: 'btn btn-danger',
            onclick: () => {
              location.hash = '#/';
            },
          },
          'Leave',
        ),
      ),
      el('div', { class: 'stage-wrap' }, stage, overlay),
      announcer,
    ),
  );

  return () => {
    leaving = true;
    if (rejoinTimer) clearTimeout(rejoinTimer);
    document.removeEventListener('fullscreenchange', onFullscreenChange);
    capture?.dispose();
    stopStats?.();
    peer?.close();
    socket?.close();
  };
}
