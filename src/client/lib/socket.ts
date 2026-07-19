import { type ClientMessage, type ServerMessage, WS_PATH } from '../../shared/protocol.js';

export interface SocketCallbacks {
  onMessage: (message: ServerMessage) => void;
  onClose: (event: { code: number; reason: string }) => void;
}

export class RemoteSocket {
  private constructor(private readonly ws: WebSocket) {}

  /** Open a socket to the server this page was served from. */
  static connect(callbacks: SocketCallbacks): Promise<RemoteSocket> {
    const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${protocol}://${location.host}${WS_PATH}`);
    return new Promise((resolve, reject) => {
      let opened = false;
      ws.addEventListener('open', () => {
        opened = true;
        resolve(new RemoteSocket(ws));
      });
      ws.addEventListener('message', (event) => {
        if (typeof event.data !== 'string') return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(event.data);
        } catch {
          return;
        }
        callbacks.onMessage(parsed as ServerMessage);
      });
      ws.addEventListener('close', (event) => {
        if (!opened) reject(new Error('Could not reach the server.'));
        else callbacks.onClose({ code: event.code, reason: event.reason });
      });
      ws.addEventListener('error', () => {
        if (!opened) reject(new Error('Could not reach the server.'));
      });
    });
  }

  send(message: ClientMessage): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(message));
  }

  close(): void {
    this.ws.close(1000, 'bye');
  }
}
