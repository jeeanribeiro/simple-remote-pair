import type { RemoteSocket } from './socket.js';

/**
 * LAN/VPN tool: host candidates are enough, so no STUN/TURN servers.
 * Signaling is relayed by the session server over the WebSocket.
 */
const RTC_CONFIG: RTCConfiguration = { iceServers: [] };

interface SignalPayload {
  sdp?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit | null;
}

function isSignalPayload(data: unknown): data is SignalPayload {
  return typeof data === 'object' && data !== null;
}

/**
 * Host side: one RTCPeerConnection per guest. Only the host ever creates
 * offers (guests never renegotiate), so there is no signaling glare to
 * resolve. Adding/removing the stream triggers renegotiation for everyone,
 * which makes late joins and share restarts "just work".
 */
export class HostPeers {
  private readonly peers = new Map<string, RTCPeerConnection>();
  private stream: MediaStream | null = null;

  constructor(private readonly socket: RemoteSocket) {}

  addGuest(guestId: string): void {
    const pc = new RTCPeerConnection(RTC_CONFIG);
    this.peers.set(guestId, pc);

    pc.onnegotiationneeded = async () => {
      try {
        await pc.setLocalDescription();
        this.socket.send({ t: 'signal', to: guestId, data: { sdp: pc.localDescription } });
      } catch {
        // Peer was torn down mid-negotiation; nothing to recover.
      }
    };
    pc.onicecandidate = (event) => {
      this.socket.send({ t: 'signal', to: guestId, data: { candidate: event.candidate } });
    };

    if (this.stream) {
      for (const track of this.stream.getTracks()) pc.addTrack(track, this.stream);
    }
  }

  removeGuest(guestId: string): void {
    this.peers.get(guestId)?.close();
    this.peers.delete(guestId);
  }

  async handleSignal(from: string, data: unknown): Promise<void> {
    const pc = this.peers.get(from);
    if (!pc || !isSignalPayload(data)) return;
    try {
      if (data.sdp && data.sdp.type === 'answer') {
        await pc.setRemoteDescription(data.sdp);
      } else if (data.candidate) {
        await pc.addIceCandidate(data.candidate);
      }
    } catch {
      // Stale signal for a replaced connection; safe to ignore.
    }
  }

  /** Start or stop streaming to every connected guest. */
  setStream(stream: MediaStream | null): void {
    this.stream = stream;
    for (const pc of this.peers.values()) {
      for (const sender of pc.getSenders()) pc.removeTrack(sender);
      if (stream) {
        for (const track of stream.getTracks()) pc.addTrack(track, stream);
      }
    }
  }

  closeAll(): void {
    for (const pc of this.peers.values()) pc.close();
    this.peers.clear();
  }
}

export interface GuestPeerCallbacks {
  onStream: (stream: MediaStream) => void;
  onConnectionState: (state: RTCPeerConnectionState) => void;
}

/** Guest side: answers the host's offers and hands the media stream to the UI. */
export class GuestPeer {
  private readonly pc: RTCPeerConnection;
  private pendingCandidates: RTCIceCandidateInit[] = [];

  constructor(
    private readonly socket: RemoteSocket,
    callbacks: GuestPeerCallbacks,
  ) {
    this.pc = new RTCPeerConnection(RTC_CONFIG);
    this.pc.ontrack = (event) => {
      const stream = event.streams[0];
      if (stream) callbacks.onStream(stream);
    };
    this.pc.onconnectionstatechange = () => {
      callbacks.onConnectionState(this.pc.connectionState);
    };
    this.pc.onicecandidate = (event) => {
      this.socket.send({ t: 'signal', data: { candidate: event.candidate } });
    };
  }

  get connection(): RTCPeerConnection {
    return this.pc;
  }

  async handleSignal(data: unknown): Promise<void> {
    if (!isSignalPayload(data)) return;
    try {
      if (data.sdp && data.sdp.type === 'offer') {
        await this.pc.setRemoteDescription(data.sdp);
        await this.pc.setLocalDescription();
        this.socket.send({ t: 'signal', data: { sdp: this.pc.localDescription } });
        for (const candidate of this.pendingCandidates) {
          await this.pc.addIceCandidate(candidate);
        }
        this.pendingCandidates = [];
      } else if (data.candidate) {
        if (this.pc.remoteDescription) await this.pc.addIceCandidate(data.candidate);
        else this.pendingCandidates.push(data.candidate);
      }
    } catch {
      // Ignore stale/duplicate signals; the next offer resets state.
    }
  }

  close(): void {
    this.pc.close();
  }
}
