import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { RoomManager, type RoomPeer } from '../../rooms/room-manager.js';
import { encodeFrame, parseDatagram, readFrames } from './framing.js';

const MAX_DATAGRAM_BYTES = 1200;
type BidirectionalStream = {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
};
type Session = {
  incomingBidirectionalStreams: ReadableStream<BidirectionalStream>;
  datagrams: {
    readable: ReadableStream<Uint8Array>;
    writable: WritableStream<Uint8Array>;
    maxDatagramSize?: number;
  };
  close: (options?: { closeCode?: number; reason?: string }) => void;
};

export async function startWebTransportServer(rooms: RoomManager): Promise<void> {
  const certPath = process.env['WT_CERT'];
  const keyPath = process.env['WT_KEY'];
  if (!certPath || !keyPath) {
    console.info('WebTransport is disabled. Set WT_CERT and WT_KEY to enable HTTP/3.');
    return;
  }
  const [{ Http3Server }, cert, privKey] = await Promise.all([
    import('@fails-components/webtransport'),
    readFile(certPath, 'utf8'),
    readFile(keyPath, 'utf8'),
  ]);
  const server = new Http3Server({
    host: process.env['WT_HOST'] ?? '0.0.0.0',
    port: Number(process.env['WT_PORT'] ?? 4443),
    secret: randomBytes(32).toString('hex'),
    cert,
    privKey,
  });
  server.startServer();
  await server.ready;
  server.setRequestCallback(async (request) => {
    const path = String(request.header[':path'] ?? '').split('?')[0];
    const origin = request.header['origin'];
    const allowedOrigins = new Set(
      (process.env['ALLOWED_ORIGINS'] ?? 'http://localhost:4200,http://127.0.0.1:4200').split(','),
    );
    if (origin && !allowedOrigins.has(origin)) return { ...request, path, status: 403 };
    if (path !== '/whiteboard') return { ...request, path, status: 404 };
    return { ...request, path, header: { ...request.header, ':path': path }, status: 200 };
  });
  const sessions = server.sessionStream('/whiteboard').getReader();
  void (async () => {
    while (true) {
      const { value: session, done } = await sessions.read();
      if (done) return;
      void handleSession(session as Session, rooms).catch((error: unknown) => {
        console.error('WebTransport session failed', error);
        (session as Session).close({ closeCode: 1011, reason: 'Session handler failed' });
      });
    }
  })().catch((error: unknown) => console.error('WebTransport session stream failed', error));
  const address = server.address();
  console.log(
    `Whiteboard WebTransport HTTP/3 listening on https://${address?.host}:${address?.port ?? 4443}`,
  );
}

async function handleSession(session: Session, rooms: RoomManager): Promise<void> {
  let peer: RoomPeer | undefined;
  let closed = false;
  const incoming = session.incomingBidirectionalStreams.getReader();
  const { value: stream } = await incoming.read();
  incoming.releaseLock();
  if (!stream) {
    session.close({ closeCode: 1008, reason: 'Reliable stream required' });
    return;
  }
  const reliableWriter = stream.writable.getWriter();
  const datagramWriter = session.datagrams.writable.getWriter();
  const send = (event: Parameters<RoomPeer['send']>[0]) => {
    if (closed) return;
    if (event.eventType === 'CURSOR_MOVE' || event.eventType === 'DRAW_MOVE') {
      const bytes = new TextEncoder().encode(JSON.stringify(event));
      if (
        bytes.byteLength <=
        Math.min(session.datagrams.maxDatagramSize ?? MAX_DATAGRAM_BYTES, MAX_DATAGRAM_BYTES)
      ) {
        void datagramWriter.write(bytes).catch(() => {});
      }
      return;
    }
    void reliableWriter.write(encodeFrame(event)).catch(() => {});
  };

  try {
    for await (const bytes of readFrames(stream.readable)) {
      const message = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
      if (!peer) {
        if (
          message['kind'] !== 'join' ||
          typeof message['roomId'] !== 'string' ||
          typeof message['name'] !== 'string'
        ) {
          throw new Error('First reliable frame must join a room');
        }
        peer = rooms.join(message['roomId'], message['name'], send, () =>
          session.close({ closeCode: 1008, reason: 'Invalid room access' }),
        );
        void readDatagrams(session.datagrams.readable, () => peer, rooms);
        continue;
      }
      rooms.receive(peer, message);
    }
  } catch (error) {
    session.close({
      closeCode: 1008,
      reason: error instanceof Error ? error.message.slice(0, 100) : 'Invalid event',
    });
  } finally {
    closed = true;
    if (peer) rooms.leave(peer);
    try {
      reliableWriter.releaseLock();
      datagramWriter.releaseLock();
    } catch {
      /* Session shutdown releases stream locks. */
    }
  }
}

async function readDatagrams(
  readable: ReadableStream<Uint8Array>,
  getPeer: () => RoomPeer | undefined,
  rooms: RoomManager,
): Promise<void> {
  const reader = readable.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return;
      if (value.byteLength > MAX_DATAGRAM_BYTES) continue;
      const peer = getPeer();
      if (!peer) continue;
      try {
        rooms.receive(peer, parseDatagram(value, MAX_DATAGRAM_BYTES));
      } catch {
        /* Invalid and stale datagrams are intentionally discarded. */
      }
    }
  } catch {
    /* Session closure ends the datagram reader. */
  } finally {
    reader.releaseLock();
  }
}
