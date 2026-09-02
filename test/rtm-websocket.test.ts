import { describe, expect, test } from "bun:test";
import { extractTextFrames } from "../src/lib/rtm-websocket.ts";

/** Build an unmasked WebSocket text frame (opcode 1) for a UTF-8 string. */
function textFrame(text: string): Buffer {
  const payload = Buffer.from(text, "utf8");
  const len = payload.length;

  if (len < 126) {
    const header = Buffer.alloc(2);
    header[0] = 0x81; // FIN + opcode 1 (text)
    header[1] = len;
    return Buffer.concat([header, payload]);
  }
  if (len < 65536) {
    const header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
    return Buffer.concat([header, payload]);
  }
  const header = Buffer.alloc(10);
  header[0] = 0x81;
  header[1] = 127;
  header.writeBigUInt64BE(BigInt(len), 2);
  return Buffer.concat([header, payload]);
}

/** Build an unmasked binary frame (opcode 2). */
function binaryFrame(data: Buffer): Buffer {
  const header = Buffer.alloc(2);
  header[0] = 0x82; // FIN + opcode 2 (binary)
  header[1] = data.length;
  return Buffer.concat([header, data]);
}

/** Build an unmasked ping frame (opcode 9). */
function pingFrame(): Buffer {
  const header = Buffer.alloc(2);
  header[0] = 0x89; // FIN + opcode 9 (ping)
  header[1] = 0;
  return header;
}

/** Build an unmasked close frame (opcode 8). */
function closeFrame(): Buffer {
  const header = Buffer.alloc(2);
  header[0] = 0x88; // FIN + opcode 8 (close)
  header[1] = 0;
  return header;
}

describe("extractTextFrames", () => {
  test("parses a single small text frame", () => {
    const frame = textFrame('{"type":"hello"}');
    const { texts, remaining } = extractTextFrames(frame);
    expect(texts).toEqual(['{"type":"hello"}']);
    expect(remaining.length).toBe(0);
  });

  test("parses multiple text frames in one buffer", () => {
    const buf = Buffer.concat([
      textFrame('{"type":"hello"}'),
      textFrame('{"type":"view_opened","view_id":"V1"}'),
    ]);
    const { texts, remaining } = extractTextFrames(buf);
    expect(texts).toEqual(['{"type":"hello"}', '{"type":"view_opened","view_id":"V1"}']);
    expect(remaining.length).toBe(0);
  });

  test("returns partial frame as remaining", () => {
    const full = textFrame('{"ok":true}');
    const partial = full.subarray(0, -3);
    const { texts, remaining } = extractTextFrames(partial);
    expect(texts).toEqual([]);
    expect(remaining.length).toBe(partial.length);
  });

  test("returns complete frames and keeps partial remainder", () => {
    const first = textFrame("complete");
    const second = textFrame("incomplete");
    const partial = second.subarray(0, -2);
    const buf = Buffer.concat([first, partial]);

    const { texts, remaining } = extractTextFrames(buf);
    expect(texts).toEqual(["complete"]);
    expect(remaining.length).toBe(partial.length);
  });

  test("skips non-text frames (binary, ping, close)", () => {
    const buf = Buffer.concat([
      pingFrame(),
      textFrame("hello"),
      binaryFrame(Buffer.from([0x01, 0x02])),
      closeFrame(),
      textFrame("world"),
    ]);
    const { texts, remaining } = extractTextFrames(buf);
    expect(texts).toEqual(["hello", "world"]);
    expect(remaining.length).toBe(0);
  });

  test("handles empty buffer", () => {
    const { texts, remaining } = extractTextFrames(Buffer.alloc(0));
    expect(texts).toEqual([]);
    expect(remaining.length).toBe(0);
  });

  test("handles buffer with only one byte (incomplete header)", () => {
    const { texts, remaining } = extractTextFrames(Buffer.from([0x81]));
    expect(texts).toEqual([]);
    expect(remaining.length).toBe(1);
  });

  test("handles 16-bit extended payload length (126-65535 bytes)", () => {
    const payload = "x".repeat(200);
    const frame = textFrame(payload);
    // Verify we built a 16-bit length frame (header byte 1 should have 126)
    expect(frame[1]! & 0x7f).toBe(126);

    const { texts, remaining } = extractTextFrames(frame);
    expect(texts).toEqual([payload]);
    expect(remaining.length).toBe(0);
  });

  test("handles 64-bit extended payload length (>65535 bytes)", () => {
    const payload = "y".repeat(70000);
    const frame = textFrame(payload);
    // Verify we built a 64-bit length frame (header byte 1 should have 127)
    expect(frame[1]! & 0x7f).toBe(127);

    const { texts, remaining } = extractTextFrames(frame);
    expect(texts).toEqual([payload]);
    expect(remaining.length).toBe(0);
  });

  test("handles incomplete 16-bit length header", () => {
    // 0x81 = FIN+text, 0x7e = 126 (16-bit length follows), then only 1 byte of the 2
    const buf = Buffer.from([0x81, 0x7e, 0x00]);
    const { texts, remaining } = extractTextFrames(buf);
    expect(texts).toEqual([]);
    expect(remaining.length).toBe(3);
  });

  test("handles incomplete 64-bit length header", () => {
    // 0x81 = FIN+text, 0x7f = 127 (64-bit length follows), then only 4 of the 8 bytes
    const buf = Buffer.from([0x81, 0x7f, 0x00, 0x00, 0x00, 0x00]);
    const { texts, remaining } = extractTextFrames(buf);
    expect(texts).toEqual([]);
    expect(remaining.length).toBe(6);
  });

  test("handles UTF-8 multibyte characters", () => {
    const payload = '{"emoji":"🤘","text":"café"}';
    const frame = textFrame(payload);
    const { texts } = extractTextFrames(frame);
    expect(texts).toEqual([payload]);
  });
});
