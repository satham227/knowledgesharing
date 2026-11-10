import { EVENT_TYPES, type EventType, type WhiteboardEvent } from '../../../../shared/protocol';

export type TransportMode = 'websocket' | 'webtransport';
export type ConnectionState =
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'disconnected'
  | 'error';
export type SimulationSettings = {
  enabled: boolean;
  delayMs: number;
  cursorRate: number;
  dropPercent: number;
  slowBulk: boolean;
};
export type ClientMetrics = {
  mode: TransportMode;
  establishmentMs: number | null;
  rttMs: number | null;
  messagesSent: number;
  messagesReceived: number;
  reliableMessagesSent: number;
  reliableMessagesReceived: number;
  datagramMessagesSent: number;
  datagramMessagesReceived: number;
  bytesSent: number;
  bytesReceived: number;
  messagesPerSecond: number;
  droppedDatagrams: number;
  reconnects: number;
  serverProcessingMs: number | null;
  syncStatus: 'waiting' | 'synced' | 'offline';
};
type Session = {
  ready: Promise<void>;
  closed: Promise<unknown>;
  datagrams: {
    readable: ReadableStream<Uint8Array>;
    writable: WritableStream<Uint8Array>;
    maxDatagramSize: number;
  };
  createBidirectionalStream(): Promise<{
    readable: ReadableStream<Uint8Array>;
    writable: WritableStream<Uint8Array>;
  }>;
  close(): void;
};
type WebTransportConstructor = new (url: string) => Session;

export class WhiteboardTransport {
  private mode: TransportMode = 'websocket';
  private roomId = '';
  private name = '';
  private userId = '';
  private socket?: WebSocket;
  private session?: Session;
  private streamWriter?: WritableStreamDefaultWriter<Uint8Array>;
  private datagramWriter?: WritableStreamDefaultWriter<Uint8Array>;
  private stopped = true;
  private retryCount = 0;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private metricTimer?: ReturnType<typeof setInterval>;
  private pingTimer?: ReturnType<typeof setInterval>;
  private lastCursorSent = 0;
  private previousMessageCount = 0;
  private readonly pingTimes = new Map<string, number>();
  private settings: SimulationSettings = {
    enabled: false,
    delayMs: 0,
    cursorRate: 30,
    dropPercent: 0,
    slowBulk: false,
  };
  private readonly metric: ClientMetrics = {
    mode: 'websocket',
    establishmentMs: null,
    rttMs: null,
    messagesSent: 0,
    messagesReceived: 0,
    reliableMessagesSent: 0,
    reliableMessagesReceived: 0,
    datagramMessagesSent: 0,
    datagramMessagesReceived: 0,
    bytesSent: 0,
    bytesReceived: 0,
    messagesPerSecond: 0,
    droppedDatagrams: 0,
    reconnects: 0,
    serverProcessingMs: null,
    syncStatus: 'offline',
  };

  constructor(
    private readonly onEvent: (event: WhiteboardEvent) => void,
    private readonly onState: (state: ConnectionState, detail?: string) => void,
    private readonly onMetrics: (metrics: ClientMetrics) => void,
  ) {}

  connect(mode: TransportMode, roomId: string, name: string): void {
    this.close();
    this.mode = mode;
    this.metric.mode = mode;
    this.roomId = roomId;
    this.name = name;
    this.stopped = false;
    this.retryCount = 0;
    this.metric.syncStatus = 'waiting';
    this.open();
    this.metricTimer = setInterval(() => {
      const current = this.metric.messagesSent + this.metric.messagesReceived;
      this.metric.messagesPerSecond = current - this.previousMessageCount;
      this.previousMessageCount = current;
      this.publishMetrics();
    }, 1000);
    this.pingTimer = setInterval(() => this.ping(), 3000);
  }

  setSimulation(settings: SimulationSettings): void {
    this.settings = settings;
  }

  sendEvent(eventType: EventType, payload: Record<string, unknown>): void {
    if (this.stopped || !this.userId) return;
    if ((eventType === 'CURSOR_MOVE' || eventType === 'DRAW_MOVE') && !this.allowCursorUpdate())
      return;
    const datagram =
      this.mode === 'webtransport' && (eventType === 'CURSOR_MOVE' || eventType === 'DRAW_MOVE');
    const eventPayload =
      this.settings.enabled && this.settings.slowBulk && !datagram
        ? { ...payload, _bulkWorkload: 'x'.repeat(12_000) }
        : payload;
    const event: WhiteboardEvent = {
      eventId: crypto.randomUUID(),
      roomId: this.roomId,
      userId: this.userId,
      eventType,
      timestamp: Date.now(),
      sequenceNumber: 0,
      payload: eventPayload,
    };
    const delay = this.settings.enabled
      ? this.settings.delayMs + (this.settings.slowBulk && !datagram ? 150 : 0)
      : 0;
    if (datagram && this.settings.enabled && Math.random() * 100 < this.settings.dropPercent) {
      this.metric.droppedDatagrams++;
      this.publishMetrics();
      return;
    }
    setTimeout(() => {
      if (datagram) this.writeDatagram(event);
      else this.writeReliable(event);
    }, delay);
  }

  close(): void {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    clearInterval(this.metricTimer);
    clearInterval(this.pingTimer);
    this.socket?.close();
    this.socket = undefined;
    this.session?.close();
    this.session = undefined;
    try {
      this.streamWriter?.releaseLock();
      this.datagramWriter?.releaseLock();
    } catch {
      /* Session may already be closed. */
    }
    this.streamWriter = undefined;
    this.datagramWriter = undefined;
    this.metric.syncStatus = 'offline';
    this.onState('disconnected');
    this.publishMetrics();
  }

  private open(): void {
    this.onState(this.retryCount ? 'reconnecting' : 'connecting');
    const started = performance.now();
    if (this.mode === 'websocket') {
      const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const socket = new WebSocket(`${scheme}//${location.host}/ws`);
      this.socket = socket;
      socket.addEventListener('open', () => {
        this.metric.establishmentMs = performance.now() - started;
        this.sendRaw(JSON.stringify({ kind: 'join', roomId: this.roomId, name: this.name }));
        this.retryCount = 0;
        this.onState('connected');
      });
      socket.addEventListener('message', (message) => {
        const text = typeof message.data === 'string' ? message.data : '';
        this.metric.bytesReceived += new TextEncoder().encode(text).byteLength;
        this.metric.messagesReceived++;
        this.metric.reliableMessagesReceived++;
        this.receiveJson(text);
      });
      socket.addEventListener('close', () => this.scheduleReconnect());
      socket.addEventListener('error', () => this.onState('error', 'WebSocket connection failed'));
      return;
    }
    const Constructor = (window as typeof window & { WebTransport?: WebTransportConstructor })
      .WebTransport;
    if (!Constructor) {
      this.onState('error', 'This browser does not expose WebTransport');
      return;
    }
    const session = new Constructor(`https://${location.hostname}:4443/whiteboard`);
    this.session = session;
    session.ready
      .then(async () => {
        this.metric.establishmentMs = performance.now() - started;
        const stream = await session.createBidirectionalStream();
        this.streamWriter = stream.writable.getWriter();
        this.datagramWriter = session.datagrams.writable.getWriter();
        await this.writeFrame({ kind: 'join', roomId: this.roomId, name: this.name });
        void this.readFrames(stream.readable, (data) =>
          this.receiveJson(new TextDecoder().decode(data)),
        );
        void this.readDatagrams(session.datagrams.readable);
        this.retryCount = 0;
        this.onState('connected');
      })
      .catch((error: unknown) => this.onState('error', String(error)));
    session.closed.then(() => this.scheduleReconnect()).catch(() => this.scheduleReconnect());
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    this.metric.reconnects++;
    this.metric.syncStatus = 'offline';
    this.retryCount++;
    this.onState('reconnecting', 'Connection lost; retrying and requesting a fresh snapshot');
    this.publishMetrics();
    this.reconnectTimer = setTimeout(
      () => {
        this.reconnectTimer = undefined;
        this.open();
      },
      Math.min(500 * 2 ** Math.min(this.retryCount, 4), 8000),
    );
  }

  private sendRaw(text: string): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(text);
    this.metric.bytesSent += new TextEncoder().encode(text).byteLength;
    this.metric.messagesSent++;
    this.metric.reliableMessagesSent++;
    this.publishMetrics();
  }

  private writeReliable(event: WhiteboardEvent): void {
    if (this.mode === 'websocket') {
      this.sendRaw(JSON.stringify(event));
      return;
    }
    void this.writeFrame(event);
  }

  private async writeFrame(message: Record<string, unknown>): Promise<void> {
    if (!this.streamWriter) return;
    const bytes = frame(new TextEncoder().encode(JSON.stringify(message)));
    await this.streamWriter.write(bytes);
    this.metric.bytesSent += bytes.byteLength;
    this.metric.messagesSent++;
    this.metric.reliableMessagesSent++;
    this.publishMetrics();
  }

  private writeDatagram(event: WhiteboardEvent): void {
    if (!this.datagramWriter) return;
    const bytes = new TextEncoder().encode(JSON.stringify(event));
    if (bytes.byteLength > (this.session?.datagrams.maxDatagramSize ?? 1200)) {
      this.metric.droppedDatagrams++;
      this.publishMetrics();
      return;
    }
    void this.datagramWriter
      .write(bytes)
      .then(() => {
        this.metric.bytesSent += bytes.byteLength;
        this.metric.messagesSent++;
        this.metric.datagramMessagesSent++;
        this.publishMetrics();
      })
      .catch(() => {
        this.metric.droppedDatagrams++;
        this.publishMetrics();
      });
  }

  private async readFrames(
    stream: ReadableStream<Uint8Array>,
    onFrame: (frame: Uint8Array) => void,
  ): Promise<void> {
    const reader = stream.getReader();
    let pending = new Uint8Array();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        const joined = new Uint8Array(pending.length + value.length);
        joined.set(pending);
        joined.set(value, pending.length);
        pending = joined;
        while (pending.length >= 4) {
          const length = new DataView(pending.buffer, pending.byteOffset, 4).getUint32(0);
          if (length > 65536) throw new Error('Reliable frame exceeds 64 KiB');
          if (pending.length < length + 4) break;
          const body = pending.slice(4, length + 4);
          this.metric.bytesReceived += body.byteLength + 4;
          this.metric.messagesReceived++;
          this.metric.reliableMessagesReceived++;
          onFrame(body);
          pending = pending.slice(length + 4);
        }
      }
    } catch (error) {
      this.onState('error', String(error));
    } finally {
      reader.releaseLock();
    }
  }

  private async readDatagrams(stream: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stream.getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        this.metric.bytesReceived += value.byteLength;
        this.metric.messagesReceived++;
        this.metric.datagramMessagesReceived++;
        this.receiveJson(new TextDecoder().decode(value));
      }
    } catch {
      /* Session closure ends this reader. */
    } finally {
      reader.releaseLock();
    }
  }

  private receiveJson(text: string): void {
    let event: WhiteboardEvent;
    try {
      event = JSON.parse(text) as WhiteboardEvent;
    } catch {
      return;
    }
    if (!EVENT_TYPES.includes(event.eventType)) return;
    if (event.eventType === 'BOARD_SNAPSHOT') {
      this.userId = String((event.payload as Record<string, unknown>)['selfUserId'] ?? '');
      this.metric.syncStatus = this.userId ? 'synced' : 'waiting';
    }
    if (event.eventType === 'PONG') {
      const sentAt = String((event.payload as Record<string, unknown>)['clientSentAt'] ?? '');
      const start = this.pingTimes.get(sentAt);
      if (start !== undefined) {
        this.metric.rttMs = performance.now() - start;
        this.pingTimes.delete(sentAt);
      }
      this.metric.serverProcessingMs = Number(
        (event.payload as Record<string, unknown>)['serverProcessingMs'] ?? 0,
      );
    }
    this.onEvent(event);
    this.publishMetrics();
  }

  private ping(): void {
    if (!this.userId) return;
    const sentAt = String(performance.now());
    this.pingTimes.set(sentAt, performance.now());
    this.sendEvent('PING', { clientSentAt: sentAt });
  }

  private allowCursorUpdate(): boolean {
    if (!this.settings.enabled) return true;
    const now = performance.now();
    const interval = 1000 / Math.max(1, this.settings.cursorRate);
    if (now - this.lastCursorSent < interval) return false;
    this.lastCursorSent = now;
    return true;
  }

  private publishMetrics(): void {
    this.onMetrics({ ...this.metric });
  }
}

function frame(bytes: Uint8Array): Uint8Array {
  const result = new Uint8Array(bytes.byteLength + 4);
  new DataView(result.buffer).setUint32(0, bytes.byteLength);
  result.set(bytes, 4);
  return result;
}
