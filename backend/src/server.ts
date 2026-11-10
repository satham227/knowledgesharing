import { createServer } from 'node:http';
import express from 'express';
import { WebSocket, WebSocketServer } from 'ws';
import { RoomManager, type RoomPeer } from './rooms/room-manager.js';
import { startWebTransportServer } from './transports/webtransport/server.js';

const port = Number(process.env['PORT'] ?? 3001);
const app = express();
const httpServer = createServer(app);
const socketServer = new WebSocketServer({
  noServer: true,
  maxPayload: 64 * 1024,
  perMessageDeflate: false,
});
const rooms = new RoomManager();
const allowedOrigins = new Set(
  (process.env['ALLOWED_ORIGINS'] ?? 'http://localhost:4200,http://127.0.0.1:4200').split(','),
);

app.get('/api/health', (_request, response) =>
  response.json({ status: 'ok', transport: 'websocket', now: Date.now() }),
);
httpServer.on('upgrade', (request, socket, head) => {
  const origin = request.headers.origin;
  if (request.url !== '/ws' || (origin && !allowedOrigins.has(origin))) {
    socket.destroy();
    return;
  }
  socketServer.handleUpgrade(request, socket, head, (client) =>
    socketServer.emit('connection', client, request),
  );
});

socketServer.on('connection', (socket) => {
  let peer: RoomPeer | undefined;
  socket.on('message', (raw) => {
    try {
      const message = JSON.parse(raw.toString()) as Record<string, unknown>;
      if (!peer) {
        if (
          message['kind'] !== 'join' ||
          typeof message['roomId'] !== 'string' ||
          typeof message['name'] !== 'string'
        ) {
          throw new Error('First message must join a room');
        }
        peer = rooms.join(
          message['roomId'],
          message['name'],
          (event) => {
            if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(event));
          },
          () => socket.close(1008, 'Invalid room access'),
        );
        return;
      }
      rooms.receive(peer, message);
    } catch (error) {
      socket.close(1008, error instanceof Error ? error.message.slice(0, 120) : 'Invalid event');
    }
  });
  socket.on('close', () => {
    if (peer) rooms.leave(peer);
  });
  socket.on('error', () => {
    if (peer) rooms.leave(peer);
  });
});

httpServer.listen(port, '0.0.0.0', () =>
  console.log(`Whiteboard WebSocket/API listening on :${port}`),
);
void startWebTransportServer(rooms).catch((error: unknown) =>
  console.error('WebTransport startup failed', error),
);
