import { randomUUID } from 'node:crypto';
import {
  type BoardObject,
  type BoardSnapshot,
  type EventType,
  type RoomUser,
  type WhiteboardEvent,
  parseClientEvent,
} from '../../../shared/protocol.js';

export type RoomPeer = {
  id: string;
  name: string;
  color: string;
  roomId: string;
  send: (event: WhiteboardEvent) => void;
  close: () => void;
  lastCursorSequence: number;
};
type Room = {
  users: Map<string, RoomPeer>;
  objects: BoardObject[];
  revision: number;
  sequence: number;
  redo: BoardObject[];
};
const colors = [
  '#e65f4c',
  '#218c78',
  '#3867d6',
  '#9c5de5',
  '#d38b23',
  '#168aad',
  '#cb5a89',
  '#548a38',
  '#ad4b2d',
  '#416d9e',
  '#8b6d21',
  '#3e8b8b',
  '#b04f4f',
  '#6e55ac',
  '#a46828',
  '#287f57',
  '#a13d77',
  '#4152a6',
  '#607c2d',
  '#d07336',
  '#7a5364',
  '#297a92',
  '#8c4a24',
  '#52633b',
];
const roomIdPattern = /^[a-zA-Z0-9_-]{3,64}$/;

export class RoomManager {
  private readonly clientEventTypes = new Set<EventType>([
    'CURSOR_MOVE',
    'DRAW_START',
    'DRAW_MOVE',
    'DRAW_END',
    'SHAPE_CREATED',
    'STICKY_NOTE_CREATED',
    'STICKY_NOTE_UPDATED',
    'OBJECT_DELETED',
    'BOARD_CLEARED',
    'UNDO',
    'REDO',
    'PING',
  ]);
  private readonly rooms = new Map<string, Room>();
  private readonly rates = new Map<string, { startedAt: number; count: number }>();

  join(
    requestedRoomId: string,
    requestedName: string,
    send: RoomPeer['send'],
    close: RoomPeer['close'],
  ): RoomPeer {
    if (!roomIdPattern.test(requestedRoomId))
      throw new Error('Room IDs must be 3-64 letters, numbers, _ or -');
    const room = this.rooms.get(requestedRoomId) ?? this.createRoom(requestedRoomId);
    if (room.users.size >= 24) throw new Error('Room is full (maximum 24 users)');
    const id = randomUUID();
    const name =
      requestedName
        .trim()
        .replace(/[<>\u0000-\u001f]/g, '')
        .slice(0, 24) || 'Guest';
    const peer: RoomPeer = {
      id,
      name,
      color:
        colors.find((color) => ![...room.users.values()].some((user) => user.color === color)) ??
        colors[0]!,
      roomId: requestedRoomId,
      send,
      close,
      lastCursorSequence: -1,
    };
    room.users.set(id, peer);
    this.send(room, peer, 'BOARD_SNAPSHOT', { ...this.snapshot(room), selfUserId: peer.id });
    this.broadcast(room, this.event(room, peer, 'USER_JOINED', { user: this.user(peer) }), peer.id);
    return peer;
  }

  leave(peer: RoomPeer): void {
    const room = this.rooms.get(peer.roomId);
    if (!room || !room.users.delete(peer.id)) return;
    this.broadcast(room, this.event(room, peer, 'USER_LEFT', { userId: peer.id }));
    for (const key of this.rates.keys()) if (key.includes(`:${peer.id}:`)) this.rates.delete(key);
  }

  receive(peer: RoomPeer, raw: unknown): WhiteboardEvent {
    const processingStarted = performance.now();
    const room = this.rooms.get(peer.roomId);
    if (!room || room.users.get(peer.id) !== peer)
      throw new Error('Peer is not a member of this room');
    const input = parseClientEvent(raw);
    if (!this.clientEventTypes.has(input.eventType)) throw new Error('Event type is server-owned');
    if (input.roomId !== peer.roomId || input.userId !== peer.id)
      throw new Error('Room or identity mismatch');
    this.enforceRate(peer, input.eventType);
    if (input.eventType === 'CURSOR_MOVE') {
      const cursorSequence = Number(input.payload['cursorSequence']);
      if (!Number.isSafeInteger(cursorSequence) || cursorSequence <= peer.lastCursorSequence)
        throw new Error('Stale cursor sequence');
      peer.lastCursorSequence = cursorSequence;
    }
    this.applyDurableOperation(room, input.eventType, input.payload, peer);
    if (input.eventType === 'PING') {
      const response = this.event(room, peer, 'PONG', {
        clientSentAt: input.payload['clientSentAt'],
        serverProcessingMs: performance.now() - processingStarted,
      });
      peer.send(response);
      return response;
    }
    const event = this.event(room, peer, input.eventType, input.payload, input.eventId);
    this.broadcast(room, event, input.eventType === 'CURSOR_MOVE' ? peer.id : undefined);
    return event;
  }

  snapshotFor(roomId: string): BoardSnapshot | undefined {
    const room = this.rooms.get(roomId);
    return room ? this.snapshot(room) : undefined;
  }

  private createRoom(roomId: string): Room {
    const room: Room = { users: new Map(), objects: [], revision: 0, sequence: 0, redo: [] };
    this.rooms.set(roomId, room);
    return room;
  }

  private snapshot(room: Room): BoardSnapshot {
    return {
      users: [...room.users.values()].map((peer) => this.user(peer)),
      objects: structuredClone(room.objects),
      revision: room.revision,
    };
  }

  private user(peer: RoomPeer): RoomUser {
    return { id: peer.id, name: peer.name, color: peer.color };
  }

  private event(
    room: Room,
    peer: RoomPeer,
    eventType: EventType,
    payload: unknown,
    eventId = randomUUID(),
  ): WhiteboardEvent {
    return {
      eventId,
      roomId: peer.roomId,
      userId: peer.id,
      eventType,
      timestamp: Date.now(),
      sequenceNumber: ++room.sequence,
      payload: payload as Record<string, unknown>,
    };
  }

  private send(room: Room, peer: RoomPeer, eventType: EventType, payload: unknown): void {
    peer.send(this.event(room, peer, eventType, payload));
  }

  private broadcast(room: Room, event: WhiteboardEvent, exceptId?: string): void {
    for (const peer of room.users.values()) if (peer.id !== exceptId) peer.send(event);
  }

  private enforceRate(peer: RoomPeer, eventType: EventType): void {
    const now = Date.now();
    const key = `${peer.roomId}:${peer.id}:${eventType === 'CURSOR_MOVE' ? 'cursor' : 'board'}`;
    const rate = this.rates.get(key);
    const limit = eventType === 'CURSOR_MOVE' ? 120 : 180;
    if (!rate || now - rate.startedAt >= 1000) {
      this.rates.set(key, { startedAt: now, count: 1 });
      return;
    }
    if (++rate.count > limit) throw new Error('Event rate limit exceeded');
  }

  private applyDurableOperation(
    room: Room,
    type: EventType,
    payload: Record<string, unknown>,
    peer: RoomPeer,
  ): void {
    if (
      type === 'DRAW_END' ||
      type === 'SHAPE_CREATED' ||
      type === 'STICKY_NOTE_CREATED' ||
      type === 'STICKY_NOTE_UPDATED'
    ) {
      const candidate = payload['object'];
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate))
        throw new Error('Missing board object');
      const object = candidate as BoardObject;
      const existing = room.objects.find((entry) => entry.id === object.id);
      const isNoteUpdate = type === 'STICKY_NOTE_UPDATED' && existing?.kind === 'sticky';
      if (
        typeof object.id !== 'string' ||
        object.id.length > 80 ||
        (!isNoteUpdate && object.userId !== peer.id)
      )
        throw new Error('Invalid board object');
      if (
        !Number.isFinite(object.x) ||
        !Number.isFinite(object.y) ||
        !Number.isFinite(object.width ?? 0) ||
        !Number.isFinite(object.height ?? 0) ||
        Math.abs(object.width ?? 0) > 2 ||
        Math.abs(object.height ?? 0) > 2 ||
        (object.text?.length ?? 0) > 280 ||
        !/^#[0-9a-f]{6}$/i.test(object.color)
      )
        throw new Error('Invalid board object geometry or color');
      if (
        !['stroke', 'rectangle', 'circle', 'line', 'arrow', 'sticky', 'text'].includes(object.kind)
      )
        throw new Error('Invalid board object kind');
      if (
        object.points &&
        (object.points.length > 2_000 ||
          object.points.some(
            (point) =>
              !Number.isFinite(point.x) ||
              !Number.isFinite(point.y) ||
              Math.abs(point.x) > 2 ||
              Math.abs(point.y) > 2,
          ))
      )
        throw new Error('Invalid board points');
      if (isNoteUpdate && existing) object.userId = existing.userId;
      const index = room.objects.findIndex((entry) => entry.id === object.id);
      if (index >= 0) room.objects[index] = structuredClone(object);
      else room.objects.push(structuredClone(object));
      room.revision++;
      room.redo = [];
    } else if (type === 'OBJECT_DELETED') {
      const id = payload['objectId'];
      if (typeof id !== 'string') throw new Error('Missing objectId');
      room.objects = room.objects.filter((object) => object.id !== id);
      room.revision++;
    } else if (type === 'BOARD_CLEARED') {
      room.objects = [];
      room.revision++;
    } else if (type === 'UNDO') {
      const object = room.objects.pop();
      if (object) room.redo.push(object);
      room.revision++;
    } else if (type === 'REDO') {
      const object = room.redo.pop();
      if (object) {
        room.objects.push(object);
        payload['object'] = object;
      }
      room.revision++;
    }
  }
}
