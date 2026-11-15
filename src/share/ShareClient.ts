import { HttpTransportType, HubConnectionBuilder, HubConnectionState, LogLevel, type HubConnection } from '@microsoft/signalr';

import { setShareAckedSequence, type ShareSession } from '../db/database';
import type { GpsSample } from '../geo/stats';
import { TAB_API_URL } from './config';

export type ShareStatus = 'connecting' | 'live' | 'reconnecting' | 'closed';

export type ShareState = {
  status: ShareStatus;
  viewerUrl: string;
  /** Recorded samples the server has not confirmed yet. */
  pending: number;
};

type Options = {
  session: ShareSession;
  /** All samples of the current journey, in sequence order (the in-memory recording buffer). */
  getSamples: () => GpsSample[];
  onState: (state: ShareState) => void;
  /** The server refused the session (closed elsewhere, expired or unknown). */
  onClosedByServer: () => void;
};

const BATCH_SIZE = 200;
const START_RETRY_MS = 5_000;

/**
 * Streams the raw samples of one journey to the backend over SignalR.
 * The server acknowledges the highest stored sequence; anything after it is (re)sent. After a
 * reconnect, Resume asks the server how far it got, so a network drop simply catches up later.
 * The server ignores duplicates, so re-sending is always safe.
 */
export class ShareClient {
  private readonly conn: HubConnection;
  private acked: number;
  private resumed = false;
  private flushing = false;
  private flushAgain = false;
  private stopped = false;
  private status: ShareStatus = 'connecting';
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly opts: Options) {
    this.acked = opts.session.lastAckedSequence;
    this.conn = new HubConnectionBuilder()
      .withUrl(`${TAB_API_URL}/hubs/trip`, { transport: HttpTransportType.WebSockets, skipNegotiation: true })
      // Never give up while the trip is shared: back off to one attempt every 30 s.
      .withAutomaticReconnect({ nextRetryDelayInMilliseconds: (ctx) => Math.min(30_000, 1_000 * 2 ** Math.min(ctx.previousRetryCount, 5)) })
      .configureLogging(LogLevel.Warning)
      .build();
    this.conn.onreconnecting(() => {
      this.resumed = false;
      this.setStatus('reconnecting');
    });
    this.conn.onreconnected(() => this.resume());
    this.conn.onclose(() => {
      this.resumed = false;
      if (!this.stopped) this.scheduleStart();
    });
  }

  start(): void {
    this.connect();
  }

  /** Call whenever a new sample has been recorded. */
  notify(): void {
    if (this.status === 'live' || this.status === 'connecting') this.emit();
    void this.flush();
  }

  /** Waits briefly for the backlog to upload (used when a trip ends), then gives up. */
  async drain(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && this.resumed && this.pendingCount() > 0) {
      await this.flush();
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.setStatus('closed');
    await this.conn.stop().catch(() => undefined);
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    try {
      this.setStatus('connecting');
      await this.conn.start();
      await this.resume();
    } catch (e) {
      console.warn('Share connection failed', e);
      this.scheduleStart();
    }
  }

  private scheduleStart(): void {
    if (this.stopped || this.retryTimer) return;
    this.setStatus('reconnecting');
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.conn.state === HubConnectionState.Disconnected) this.connect();
    }, START_RETRY_MS);
  }

  private async resume(): Promise<void> {
    try {
      const { sessionId, ownerToken } = this.opts.session;
      // The server is the source of truth for what it has stored.
      this.acked = await this.conn.invoke<number>('Resume', sessionId, ownerToken);
      this.resumed = true;
      this.setStatus('live');
      await this.flush();
    } catch (e) {
      this.handleError(e);
    }
  }

  private async flush(): Promise<void> {
    if (this.flushing) {
      this.flushAgain = true;
      return;
    }
    if (this.stopped || !this.resumed || this.conn.state !== HubConnectionState.Connected) return;
    this.flushing = true;
    try {
      do {
        this.flushAgain = false;
        const pending = this.opts.getSamples().filter((s) => s.sequence > this.acked);
        if (pending.length === 0) break;
        const batch = pending.slice(0, BATCH_SIZE).map(toDto);
        const { sessionId, ownerToken } = this.opts.session;
        this.acked = await this.conn.invoke<number>('PublishSamples', sessionId, ownerToken, batch);
        setShareAckedSequence(sessionId, this.acked).catch(() => undefined);
        this.emit();
        if (pending.length > BATCH_SIZE) this.flushAgain = true;
      } while (this.flushAgain && !this.stopped);
    } catch (e) {
      this.handleError(e);
    } finally {
      this.flushing = false;
    }
  }

  private handleError(e: unknown): void {
    const message = String((e as Error)?.message ?? e);
    // HubException messages from TripHub: the session is gone for good.
    if (message.includes('session-closed') || message.includes('unauthorized')) {
      void this.stop();
      this.opts.onClosedByServer();
      return;
    }
    // Connection problems: automatic reconnect + Resume takes care of the backlog.
    console.warn('Share upload failed', message);
  }

  private pendingCount(): number {
    const samples = this.opts.getSamples();
    const last = samples.length > 0 ? samples[samples.length - 1].sequence : -1;
    return Math.max(0, last - this.acked);
  }

  private setStatus(status: ShareStatus): void {
    if (this.status === 'closed' && status !== 'closed') return;
    this.status = status;
    this.emit();
  }

  private emit(): void {
    this.opts.onState({ status: this.status, viewerUrl: this.opts.session.viewerUrl, pending: this.pendingCount() });
  }
}

/** The wire format expected by the backend (SampleDto); raw values, no journey id. */
function toDto(s: GpsSample) {
  return {
    sequence: s.sequence,
    timestampUtc: s.timestampUtc,
    latitude: s.latitude,
    longitude: s.longitude,
    speedMps: s.speedMps,
    accuracyMeters: s.accuracyMeters,
    altitudeMeters: s.altitudeMeters,
    heading: s.heading,
    provider: s.provider,
    satellitesUsed: s.satellitesUsed,
    satellitesInView: s.satellitesInView,
    speedAccuracyMps: s.speedAccuracyMps,
    bearingAccuracyDeg: s.bearingAccuracyDeg,
  };
}
