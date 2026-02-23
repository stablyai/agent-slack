/**
 * Short-lived RTM WebSocket connection using node:https upgrade.
 * Bun delivers HTTP 101 via the response callback (not the 'upgrade' event),
 * so we read WebSocket frames directly from the response stream.
 */
import { request } from "node:https";

export type RtmConnection = {
  waitForMessage: (
    predicate: (msg: Record<string, unknown>) => boolean,
    timeoutMs?: number,
  ) => Promise<Record<string, unknown>>;
  close: () => void;
};

export function connectRtm(input: {
  wsUrl: string;
  cookie: string;
  timeoutMs?: number;
}): Promise<RtmConnection> {
  const { wsUrl, cookie, timeoutMs = 5000 } = input;
  const url = new URL(wsUrl.replace("wss://", "https://"));
  const keyBytes = new Uint8Array(16);
  crypto.getRandomValues(keyBytes);
  const wsKey = btoa(String.fromCharCode(...keyBytes));

  const messages: Record<string, unknown>[] = [];
  const listeners: ((msg: Record<string, unknown>) => void)[] = [];
  let buffer: Buffer = Buffer.alloc(0);
  let req: ReturnType<typeof request> | null = null;
  let res: { destroy: () => void } | null = null;
  let closed = false;

  function onFrame(text: string): void {
    try {
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed === "object" && parsed !== null) {
        const msg = parsed as Record<string, unknown>;
        messages.push(msg);
        for (const listener of listeners) {
          listener(msg);
        }
      }
    } catch {
      // ignore non-JSON frames
    }
  }

  function close(): void {
    if (closed) {
      return;
    }
    closed = true;
    try {
      res?.destroy();
    } catch {
      // ignore
    }
    try {
      req?.destroy();
    } catch {
      // ignore
    }
  }

  return new Promise<RtmConnection>((resolve, reject) => {
    const timeout = setTimeout(() => {
      close();
      reject(new Error("RTM WebSocket connection timed out"));
    }, timeoutMs);

    req = request(
      {
        hostname: url.hostname,
        port: 443,
        path: url.pathname + url.search,
        method: "GET",
        headers: {
          Upgrade: "websocket",
          Connection: "Upgrade",
          Cookie: cookie,
          Origin: "https://app.slack.com",
          "Sec-WebSocket-Key": wsKey,
          "Sec-WebSocket-Version": "13",
        },
      },
      (response) => {
        res = response;
        if (response.statusCode !== 101) {
          clearTimeout(timeout);
          close();
          reject(new Error(`RTM WebSocket connection failed: HTTP ${response.statusCode}`));
          return;
        }

        response.on("data", (chunk: Buffer) => {
          buffer = Buffer.concat([buffer, chunk]);
          const { texts, remaining } = extractTextFrames(buffer);
          buffer = remaining;
          for (const text of texts) {
            onFrame(text);
          }
        });

        // Wait briefly for the hello message before resolving
        setTimeout(() => {
          clearTimeout(timeout);
          resolve({ waitForMessage, close });
        }, 300);
      },
    );

    req.on("error", (err: Error) => {
      clearTimeout(timeout);
      close();
      reject(new Error(`RTM WebSocket connection failed: ${err.message}`));
    });

    req.end();
  });

  function waitForMessage(
    predicate: (msg: Record<string, unknown>) => boolean,
    waitTimeoutMs = 15000,
  ): Promise<Record<string, unknown>> {
    // Check already-received messages first
    for (const msg of messages) {
      if (predicate(msg)) {
        return Promise.resolve(msg);
      }
    }

    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = listeners.indexOf(listener);
        if (idx >= 0) {
          listeners.splice(idx, 1);
        }
        reject(new Error(`Timed out waiting for message (${waitTimeoutMs / 1000}s)`));
      }, waitTimeoutMs);

      function listener(msg: Record<string, unknown>): void {
        if (predicate(msg)) {
          clearTimeout(timer);
          const idx = listeners.indexOf(listener);
          if (idx >= 0) {
            listeners.splice(idx, 1);
          }
          resolve(msg);
        }
      }

      listeners.push(listener);
    });
  }
}

/**
 * Parse WebSocket text frames from a raw byte buffer.
 * Server→client frames are unmasked per RFC 6455.
 */
export function extractTextFrames(buf: Buffer): {
  texts: string[];
  remaining: Buffer;
} {
  const texts: string[] = [];
  let pos = 0;

  while (pos < buf.length) {
    if (buf.length - pos < 2) {
      break;
    }
    const opcode = buf[pos]! & 0x0f;
    const masked = (buf[pos + 1]! & 0x80) !== 0;
    let payloadLen = buf[pos + 1]! & 0x7f;
    let headerLen = 2;

    if (payloadLen === 126) {
      if (buf.length - pos < 4) {
        break;
      }
      payloadLen = buf.readUInt16BE(pos + 2);
      headerLen = 4;
    } else if (payloadLen === 127) {
      if (buf.length - pos < 10) {
        break;
      }
      payloadLen = Number(buf.readBigUInt64BE(pos + 2));
      headerLen = 10;
    }
    if (masked) {
      headerLen += 4;
    }

    const totalLen = headerLen + payloadLen;
    if (buf.length - pos < totalLen) {
      break;
    }

    if (opcode === 1) {
      const payload = buf.subarray(pos + headerLen, pos + totalLen);
      texts.push(payload.toString("utf8"));
    }
    pos += totalLen;
  }

  return { texts, remaining: buf.subarray(pos) };
}
