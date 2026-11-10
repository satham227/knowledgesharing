export const EVENT_TYPES = [
  'USER_JOINED',
  'USER_LEFT',
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
  'BOARD_SNAPSHOT',
  'PING',
  'PONG',
] as const;

export type EventType = (typeof EVENT_TYPES)[number];
export type Point = { x: number; y: number };
export type BoardObject = {
  id: string;
  kind: 'stroke' | 'rectangle' | 'circle' | 'line' | 'arrow' | 'sticky' | 'text';
  points?: Point[];
  x: number;
  y: number;
  width?: number;
  height?: number;
  color: string;
  text?: string;
  userId: string;
};
export type RoomUser = { id: string; name: string; color: string };
export type BoardSnapshot = { users: RoomUser[]; objects: BoardObject[]; revision: number };
export type WhiteboardEvent<T = Record<string, unknown>> = {
  eventId: string;
  roomId: string;
  userId: string;
  eventType: EventType;
  timestamp: number;
  sequenceNumber: number;
  payload: T;
};

const allowedTypes = new Set<string>(EVENT_TYPES);

export function parseClientEvent(value: unknown): Omit<WhiteboardEvent, 'sequenceNumber'> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Event must be an object');
  const event = value as Record<string, unknown>;
  if (typeof event['eventId'] !== 'string' || event['eventId'].length > 80)
    throw new Error('Invalid eventId');
  if (typeof event['roomId'] !== 'string' || event['roomId'].length > 64)
    throw new Error('Invalid roomId');
  if (typeof event['userId'] !== 'string' || event['userId'].length > 80)
    throw new Error('Invalid userId');
  if (typeof event['eventType'] !== 'string' || !allowedTypes.has(event['eventType']))
    throw new Error('Invalid eventType');
  if (!Number.isFinite(event['timestamp'])) throw new Error('Invalid timestamp');
  if (!Number.isSafeInteger(event['sequenceNumber']) || (event['sequenceNumber'] as number) < 0) {
    throw new Error('Invalid sequenceNumber');
  }
  if (
    !event['payload'] ||
    typeof event['payload'] !== 'object' ||
    Array.isArray(event['payload'])
  ) {
    throw new Error('Invalid payload');
  }
  if (new TextEncoder().encode(JSON.stringify(event)).byteLength > 65_536) {
    throw new Error('Event exceeds 64 KiB');
  }
  return event as Omit<WhiteboardEvent, 'sequenceNumber'>;
}
