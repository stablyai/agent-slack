import type { SlackAuth } from "./client.ts";
import { isRecord } from "../lib/object-type-guards.ts";

export type SlackEvent = Record<string, unknown>;

export type EventSocket = {
  /** Resolve with the first buffered or future event matching `predicate`. */
  waitFor: (predicate: (event: SlackEvent) => boolean, timeoutMs: number) => Promise<SlackEvent>;
  close: () => void;
};

export type EventSocketConnector = (auth: SlackAuth) => Promise<EventSocket>;

const SOCKET_HOST = "wss-primary.slack.com";
const HELLO_TIMEOUT_MS = 10_000;

/**
 * Open the realtime event stream the Slack web client uses. Browser auth only:
 * the stream is authenticated with the xoxc token plus the `d` cookie.
 * Events are buffered from the moment the socket says hello, so a caller can
 * trigger an action first and wait for its event afterwards.
 */
export async function connectEventSocket(auth: SlackAuth): Promise<EventSocket> {
  if (auth.auth_type !== "browser") {
    throw new Error(
      "Receiving Slack events requires browser credentials (xoxc token + d cookie); run `agent-slack auth import-desktop` or import from a browser.",
    );
  }
  const url = `wss://${SOCKET_HOST}/?token=${encodeURIComponent(auth.xoxc_token)}&batch_presence_aware=1`;
  // `headers` is supported by Bun and Node (undici) WebSocket implementations.
  const socket = new WebSocket(url, {
    headers: {
      Cookie: `d=${encodeURIComponent(auth.xoxd_cookie)}`,
      Origin: "https://app.slack.com",
    },
  } as unknown as string[]);

  const buffer: SlackEvent[] = [];
  const listeners = new Set<(event: SlackEvent) => void>();

  socket.addEventListener("message", (message) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(String(message.data));
    } catch {
      return;
    }
    if (!isRecord(parsed) || parsed.type === "hello") {
      return;
    }
    buffer.push(parsed);
    for (const listener of listeners) {
      listener(parsed);
    }
  });

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error("Timed out connecting to the Slack event stream."));
    }, HELLO_TIMEOUT_MS);
    const onHello = (message: MessageEvent) => {
      try {
        const parsed: unknown = JSON.parse(String(message.data));
        if (isRecord(parsed) && parsed.type === "hello") {
          clearTimeout(timer);
          socket.removeEventListener("message", onHello);
          resolve();
        }
      } catch {
        // ignore non-JSON frames
      }
    };
    socket.addEventListener("message", onHello);
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("Could not connect to the Slack event stream."));
    });
    socket.addEventListener("close", () => {
      clearTimeout(timer);
      reject(new Error("The Slack event stream closed before it was ready."));
    });
  });

  return {
    waitFor: (predicate, timeoutMs) =>
      new Promise<SlackEvent>((resolve, reject) => {
        const existing = buffer.find(predicate);
        if (existing) {
          resolve(existing);
          return;
        }
        const timer = setTimeout(() => {
          listeners.delete(listener);
          reject(new Error("Timed out waiting for a Slack event."));
        }, timeoutMs);
        const listener = (event: SlackEvent) => {
          if (predicate(event)) {
            clearTimeout(timer);
            listeners.delete(listener);
            resolve(event);
          }
        };
        listeners.add(listener);
      }),
    close: () => socket.close(),
  };
}
