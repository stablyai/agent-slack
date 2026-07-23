import { HttpsProxyAgent } from "https-proxy-agent";
import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";

let globalDispatcherInstalled = false;

/**
 * Route the runtime's global `fetch` (canvas/upload/download/update-check calls)
 * through HTTPS_PROXY/HTTP_PROXY/NO_PROXY when set. Node's built-in fetch doesn't
 * read these env vars itself; undici's global dispatcher is shared with it via a
 * well-known Symbol, so setting it here also affects `fetch` calls elsewhere in
 * the app. Safe to call multiple times or under Bun, whose fetch already honors
 * these env vars natively.
 */
export function installProxyDispatcher(): void {
  if (globalDispatcherInstalled) {
    return;
  }
  globalDispatcherInstalled = true;
  setGlobalDispatcher(new EnvHttpProxyAgent());
}

function getProxyUrl(): string | undefined {
  return (
    process.env.HTTPS_PROXY?.trim() ||
    process.env.https_proxy?.trim() ||
    process.env.HTTP_PROXY?.trim() ||
    process.env.http_proxy?.trim() ||
    undefined
  );
}

/**
 * @slack/web-api's WebClient runs on axios, which explicitly disables its own
 * env-var proxy detection (it doesn't support CONNECT tunneling to TLS
 * destinations) and instead expects callers to supply an `agent`.
 */
export function getSlackProxyAgent(): HttpsProxyAgent<string> | undefined {
  const proxyUrl = getProxyUrl();
  return proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;
}
