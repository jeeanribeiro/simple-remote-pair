export interface StreamStats {
  fps: number | undefined;
  width: number | undefined;
  height: number | undefined;
  rttMs: number | undefined;
}

/** Poll WebRTC stats every 2s; returns a stop function. */
export function watchStats(
  pc: RTCPeerConnection,
  onStats: (stats: StreamStats) => void,
): () => void {
  const timer = setInterval(async () => {
    try {
      const report = await pc.getStats();
      const stats: StreamStats = {
        fps: undefined,
        width: undefined,
        height: undefined,
        rttMs: undefined,
      };
      for (const entry of report.values()) {
        if (entry.type === 'inbound-rtp' && entry.kind === 'video') {
          stats.fps = entry.framesPerSecond;
          stats.width = entry.frameWidth;
          stats.height = entry.frameHeight;
        }
        if (entry.type === 'candidate-pair' && entry.nominated && entry.state === 'succeeded') {
          if (typeof entry.currentRoundTripTime === 'number') {
            stats.rttMs = Math.round(entry.currentRoundTripTime * 1000);
          }
        }
      }
      onStats(stats);
    } catch {
      // Connection is closing; the view will stop us shortly.
    }
  }, 2000);
  return () => clearInterval(timer);
}
