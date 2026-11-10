import assert from 'node:assert/strict';
import test from 'node:test';
import { encodeFrame, parseDatagram, readFrames } from './framing.js';

test('reads partial and coalesced length-prefixed JSON frames', async () => {
  const first = encodeFrame({ eventType: 'DRAW_END' });
  const second = encodeFrame({ eventType: 'PING' });
  const combined = new Uint8Array(first.length + second.length);
  combined.set(first);
  combined.set(second, first.length);
  const chunks = [
    combined.slice(0, 3),
    combined.slice(3, first.length + 2),
    combined.slice(first.length + 2),
  ];
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      chunks.forEach((chunk) => controller.enqueue(chunk));
      controller.close();
    },
  });
  const frames: unknown[] = [];
  for await (const bytes of readFrames(stream))
    frames.push(JSON.parse(new TextDecoder().decode(bytes)));
  assert.deepEqual(frames, [{ eventType: 'DRAW_END' }, { eventType: 'PING' }]);
});

test('rejects oversized and truncated frames', async () => {
  const oversized = new Uint8Array(4);
  new DataView(oversized.buffer).setUint32(0, 65_537);
  const oversizedStream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(oversized);
      controller.close();
    },
  });
  await assert.rejects(async () => {
    for await (const _frame of readFrames(oversizedStream)) {
      /* drain */
    }
  }, /64 KiB/);
  const truncatedStream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([0, 0, 0, 3, 1]));
      controller.close();
    },
  });
  await assert.rejects(async () => {
    for await (const _frame of readFrames(truncatedStream)) {
      /* drain */
    }
  }, /Truncated/);
});

test('parses bounded JSON datagrams and rejects malformed or oversized data', () => {
  const bytes = new TextEncoder().encode(JSON.stringify({ eventType: 'CURSOR_MOVE', sequence: 4 }));
  assert.deepEqual(parseDatagram(bytes), { eventType: 'CURSOR_MOVE', sequence: 4 });
  assert.throws(() => parseDatagram(new Uint8Array(1201)), /size limit/);
  assert.throws(() => parseDatagram(new TextEncoder().encode('{bad')), /JSON/);
});
