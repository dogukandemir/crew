/**
 * WebSocket client for the Crew event firehose (docs/11 §3).
 *
 * Responsibilities:
 *  - connect to `ws://…/ws/projects/{id}?since_seq=N`,
 *  - coalesce high-frequency frames into ~100 ms batches,
 *  - persist the highest seen `seq` per project in localStorage and resume
 *    with `since_seq` on reconnect,
 *  - ping every 20 s and treat 90 s of silence as a disconnect,
 *  - reconnect with exponential backoff + jitter,
 *  - surface `gap` frames instead of silently dropping events.
 *
 * The class is transport-only: consumers (the socket provider) own where the
 * frames land. It never throws on a dead backend — it reports state.
 */
import { api } from '../api/client';
import type { EventRow, EventFilters, UnitRef, WsError, WsFrame, WsGap, WsHello, WsMetrics, WsStage } from '../api/types';
import { eventsFromFrame } from './events';

export type ConnectionState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'disconnected';

export interface SocketListeners {
  onState?: (state: ConnectionState, detail?: string) => void;
  onHello?: (hello: WsHello) => void;
  onEvents?: (events: EventRow[]) => void;
  onGap?: (gap: WsGap) => void;
  onStage?: (frame: WsStage) => void;
  onMetrics?: (frame: WsMetrics) => void;
  onReplayComplete?: (upTo: number) => void;
  onError?: (err: WsError) => void;
}

export interface CrewSocketOptions {
  /** Coalescing window for event frames (docs/11 §3: server batches at 100 ms). */
  coalesceMs?: number;
  pingMs?: number;
  silenceMs?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  /** Disable timers/reconnects (used by tests and SSR paths). */
  autoConnect?: boolean;
}

const SINCE_SEQ_PREFIX = 'crew.since_seq.';

function storage(): Storage | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage;
  } catch {
    return null;
  }
}

export function sinceSeqKey(projectId: string): string {
  return `${SINCE_SEQ_PREFIX}${projectId}`;
}

export function readSinceSeq(projectId: string): number {
  const store = storage();
  if (!store) return 0;
  const raw = store.getItem(sinceSeqKey(projectId));
  const n = raw ? Number.parseInt(raw, 10) : 0;
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function writeSinceSeq(projectId: string, seq: number): void {
  const store = storage();
  if (!store || !Number.isFinite(seq) || seq <= 0) return;
  const previous = readSinceSeq(projectId);
  if (seq <= previous) return;
  try {
    store.setItem(sinceSeqKey(projectId), String(seq));
  } catch {
    /* quota / private mode — the in-memory cursor still works */
  }
}

export function clearSinceSeq(projectId: string): void {
  const store = storage();
  if (!store) return;
  try {
    store.removeItem(sinceSeqKey(projectId));
  } catch {
    /* ignore */
  }
}

export class CrewSocket {
  readonly projectId: string;

  private ws: WebSocket | null = null;
  private listeners = new Set<SocketListeners>();
  private stateValue: ConnectionState = 'idle';
  private detail: string | undefined;

  private readonly coalesceMs: number;
  private readonly pingMs: number;
  private readonly silenceMs: number;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;

  private pending: EventRow[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private silenceTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  private attempt = 0;
  private highestSeq = 0;
  private filters: EventFilters | undefined;
  private stopped = false;

  constructor(projectId: string, opts: CrewSocketOptions = {}) {
    this.projectId = projectId;
    this.coalesceMs = opts.coalesceMs ?? 100;
    this.pingMs = opts.pingMs ?? 20_000;
    this.silenceMs = opts.silenceMs ?? 90_000;
    this.baseBackoffMs = opts.baseBackoffMs ?? 1_000;
    this.maxBackoffMs = opts.maxBackoffMs ?? 30_000;
    this.highestSeq = readSinceSeq(projectId);
    if (opts.autoConnect !== false) this.start();
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  subscribe(listeners: SocketListeners): () => void {
    this.listeners.add(listeners);
    listeners.onState?.(this.stateValue, this.detail);
    return () => {
      this.listeners.delete(listeners);
    };
  }

  get state(): ConnectionState {
    return this.stateValue;
  }

  get seq(): number {
    return this.highestSeq;
  }

  start(): void {
    this.stopped = false;
    this.open();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    this.flush();
    if (this.ws) {
      const ws = this.ws;
      this.ws = null;
      try {
        ws.close(1000, 'client stop');
      } catch {
        /* ignore */
      }
    }
    this.setState('idle');
  }

  send(frame: Record<string, unknown>): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(JSON.stringify(frame));
    } catch {
      /* socket died mid-send; the close handler reconnects */
    }
  }

  subscribeFilters(filters: EventFilters | undefined): void {
    this.filters = filters;
    this.send({ action: 'subscribe', filters: filters ?? {}, since_seq: this.highestSeq });
  }

  steer(target: UnitRef, text: string): void {
    this.send({ action: 'steer', target, text });
  }

  /** Force a reconnect (the "resume" affordance in the disconnected banner). */
  resume(): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.subscribeFilters(this.filters);
      return;
    }
    this.attempt = 0;
    this.open();
  }

  // ── Connection lifecycle ───────────────────────────────────────────────────

  private open(): void {
    if (this.stopped) return;
    this.clearTimers();
    this.setState(this.attempt === 0 ? 'connecting' : 'reconnecting');

    let ws: WebSocket;
    try {
      ws = new WebSocket(api.wsUrl(this.projectId, this.highestSeq), api.wsProtocols());
    } catch (err) {
      this.scheduleReconnect(err instanceof Error ? err.message : 'socket construction failed');
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      this.attempt = 0;
      this.setState('connected');
      this.send({
        action: 'subscribe',
        filters: this.filters ?? {},
        since_seq: this.highestSeq,
      });
      this.armPing();
      this.armSilence();
    };

    ws.onmessage = (ev: MessageEvent) => this.onMessage(ev.data);

    ws.onerror = () => {
      this.emit('onError', { type: 'error', code: 'socket_error', detail: 'transport error' });
    };

    ws.onclose = (ev: CloseEvent) => {
      if (this.stopped) return;
      this.flush();
      this.scheduleReconnect(ev.reason || `closed (${ev.code})`);
    };
  }

  private onMessage(data: unknown): void {
    this.armSilence();
    if (typeof data !== 'string') return;
    let frame: WsFrame;
    try {
      frame = JSON.parse(data) as WsFrame;
    } catch {
      return;
    }
    if (!frame || typeof frame !== 'object') return;

    switch (frame.type) {
      case 'hello': {
        this.emit('onHello', frame);
        break;
      }
      case 'event':
      case 'events': {
        const events = eventsFromFrame(frame);
        if (events.length) this.enqueue(events);
        break;
      }
      case 'gap': {
        // The server replays the missing interval from durable storage. Do not skip it.
        this.emit('onGap', frame);
        break;
      }
      case 'replay.complete': {
        this.emit('onReplayComplete', frame.up_to);
        break;
      }
      case 'stage': {
        this.emit('onStage', frame);
        break;
      }
      case 'metrics': {
        this.emit('onMetrics', frame);
        break;
      }
      case 'pong': {
        break;
      }
      case 'error': {
        this.emit('onError', frame);
        break;
      }
      default:
        break;
    }
  }

  private enqueue(events: EventRow[]): void {
    this.pending.push(...events);
    for (const e of events) this.bumpSeq(e.seq);
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, this.coalesceMs);
  }

  private flush(): void {
    if (this.pending.length === 0) return;
    const batch = this.pending;
    this.pending = [];
    this.emit('onEvents', batch);
  }

  private bumpSeq(seq: number): void {
    if (seq > this.highestSeq) {
      this.highestSeq = seq;
      writeSinceSeq(this.projectId, seq);
    }
  }

  private armPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => this.send({ action: 'ping', ts: Date.now() }), this.pingMs);
  }

  private armSilence(): void {
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    this.silenceTimer = setTimeout(() => {
      // docs/11 §3: 90 s of silence → show the disconnected banner and retry.
      this.detail = 'no frames for 90s';
      this.setState('disconnected', this.detail);
      if (this.ws) {
        try {
          this.ws.close(4000, 'silence');
        } catch {
          /* ignore */
        }
      }
    }, this.silenceMs);
  }

  private scheduleReconnect(reason?: string): void {
    if (this.stopped) return;
    this.detail = reason;
    this.setState('disconnected', reason);
    this.clearTimers();
    const delay = Math.min(this.maxBackoffMs, this.baseBackoffMs * 2 ** this.attempt);
    const jitter = Math.random() * Math.min(500, delay * 0.25);
    this.attempt += 1;
    this.reconnectTimer = setTimeout(() => this.open(), delay + jitter);
  }

  private clearTimers(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.silenceTimer) {
      clearTimeout(this.silenceTimer);
      this.silenceTimer = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private setState(state: ConnectionState, detail?: string): void {
    if (this.stateValue === state && this.detail === detail) return;
    this.stateValue = state;
    this.detail = detail;
    for (const l of this.listeners) l.onState?.(state, detail);
  }

  private emit<K extends keyof SocketListeners>(
    key: K,
    ...args: Parameters<NonNullable<SocketListeners[K]>>
  ): void {
    for (const l of this.listeners) {
      const fn = l[key] as ((...a: unknown[]) => void) | undefined;
      fn?.(...args);
    }
  }
}
