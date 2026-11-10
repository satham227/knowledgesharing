import assert from 'node:assert/strict';
import test from 'node:test';
import { RoomManager } from './room-manager.js';

const event = (roomId: string, userId: string, eventType = 'CURSOR_MOVE', cursorSequence = 1) => ({
  eventId: `event-${cursorSequence}`,
  roomId,
  userId,
  eventType,
  timestamp: Date.now(),
  sequenceNumber: 0,
  payload: { cursorSequence, x: 10, y: 20 },
});

test('room membership is isolated and client identities are server-owned', () => {
  const manager = new RoomManager();
  const receivedA: unknown[] = [];
  const receivedB: unknown[] = [];
  const peerA = manager.join(
    'room-a',
    'Alice',
    (value) => receivedA.push(value),
    () => {},
  );
  const peerB = manager.join(
    'room-b',
    'Bob',
    (value) => receivedB.push(value),
    () => {},
  );
  assert.notEqual(peerA.id, 'client-supplied');
  assert.throws(() => manager.receive(peerA, event('room-b', peerA.id)), /mismatch/);
  assert.throws(() => manager.receive(peerB, event('room-b', peerA.id)), /mismatch/);
  assert.equal(receivedA.length, 1);
  assert.equal(receivedB.length, 1);
});

test('rejects invalid event types and stale cursors', () => {
  const manager = new RoomManager();
  const peer = manager.join(
    'room-c',
    'Casey',
    () => {},
    () => {},
  );
  assert.throws(
    () => manager.receive(peer, { ...event('room-c', peer.id), eventType: 'NOT_REAL' }),
    /eventType/,
  );
  manager.receive(peer, event('room-c', peer.id, 'CURSOR_MOVE', 2));
  assert.throws(
    () => manager.receive(peer, event('room-c', peer.id, 'CURSOR_MOVE', 1)),
    /Stale cursor/,
  );
});

test('rejects client-forged system events and assigns room sequence numbers', () => {
  const manager = new RoomManager();
  const peer = manager.join(
    'room-seq',
    'Sam',
    () => {},
    () => {},
  );
  assert.throws(
    () => manager.receive(peer, { ...event('room-seq', peer.id), eventType: 'BOARD_SNAPSHOT' }),
    /server-owned/,
  );
  const first = manager.receive(peer, event('room-seq', peer.id, 'CURSOR_MOVE', 1));
  const second = manager.receive(peer, event('room-seq', peer.id, 'CURSOR_MOVE', 2));
  assert.ok(second.sequenceNumber > first.sequenceNumber);
});

test('synchronizes sticky-note edits from another room member', () => {
  const manager = new RoomManager();
  const messagesForFirst: any[] = [];
  const first = manager.join(
    'room-notes',
    'Alex',
    (message) => messagesForFirst.push(message),
    () => {},
  );
  const second = manager.join(
    'room-notes',
    'Blair',
    () => {},
    () => {},
  );
  const object = {
    id: 'note-1',
    kind: 'sticky',
    x: 0.1,
    y: 0.2,
    width: 0.2,
    height: 0.15,
    color: '#f2ce76',
    text: 'First',
    userId: first.id,
  };
  manager.receive(first, {
    eventId: 'note-create',
    roomId: first.roomId,
    userId: first.id,
    eventType: 'STICKY_NOTE_CREATED',
    timestamp: Date.now(),
    sequenceNumber: 0,
    payload: { object },
  });
  manager.receive(second, {
    eventId: 'note-update',
    roomId: second.roomId,
    userId: second.id,
    eventType: 'STICKY_NOTE_UPDATED',
    timestamp: Date.now(),
    sequenceNumber: 0,
    payload: { object: { ...object, text: 'Updated by Blair' } },
  });
  const snapshot = manager.snapshotFor(first.roomId);
  assert.equal(snapshot?.objects[0]?.text, 'Updated by Blair');
  assert.equal(snapshot?.objects[0]?.userId, first.id);
  assert.ok(messagesForFirst.some((message) => message.eventType === 'STICKY_NOTE_UPDATED'));
});

test('sends an initial board snapshot and synchronizes completed objects', () => {
  const manager = new RoomManager();
  const messages: any[] = [];
  const peer = manager.join(
    'room-d',
    'Drew',
    (value) => messages.push(value),
    () => {},
  );
  assert.equal(messages[0].eventType, 'BOARD_SNAPSHOT');
  manager.receive(peer, {
    eventId: 'shape-1',
    roomId: peer.roomId,
    userId: peer.id,
    eventType: 'DRAW_END',
    timestamp: Date.now(),
    sequenceNumber: 0,
    payload: {
      object: {
        id: 'shape-1',
        kind: 'stroke',
        x: 1,
        y: 2,
        color: '#123456',
        userId: peer.id,
        points: [{ x: 1, y: 2 }],
      },
    },
  });
  assert.equal(manager.snapshotFor(peer.roomId)?.objects.length, 1);
  manager.leave(peer);
  assert.equal(manager.snapshotFor(peer.roomId)?.objects.length, 1);
});
