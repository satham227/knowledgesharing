export function encodeFrame(value: unknown): Uint8Array {
  const body = new TextEncoder().encode(JSON.stringify(value));
  if (body.byteLength > 65_536) throw new Error('Frame exceeds 64 KiB');
  const frame = new Uint8Array(body.byteLength + 4);
  new DataView(frame.buffer).setUint32(0, body.byteLength);
  frame.set(body, 4);
  return frame;
}

export function parseDatagram(bytes: Uint8Array, maxBytes = 1200): unknown {
  if (bytes.byteLength > maxBytes) throw new Error('Datagram exceeds size limit');
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

export async function* readFrames(stream: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader();
  let pending = new Uint8Array();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const joined = new Uint8Array(pending.byteLength + value.byteLength);
      joined.set(pending);
      joined.set(value, pending.byteLength);
      pending = joined;
      while (pending.byteLength >= 4) {
        const length = new DataView(pending.buffer, pending.byteOffset, 4).getUint32(0);
        if (length > 65_536) throw new Error('Frame exceeds 64 KiB');
        if (pending.byteLength < length + 4) break;
        yield pending.slice(4, length + 4);
        pending = pending.slice(length + 4);
      }
    }
    if (pending.byteLength) throw new Error('Truncated reliable frame');
  } finally {
    reader.releaseLock();
  }
}
