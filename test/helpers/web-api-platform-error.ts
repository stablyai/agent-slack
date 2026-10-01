import { ErrorCode, type WebAPIPlatformError } from "@slack/web-api";

/** What `WebClient.apiCall` throws when Slack answers `ok: false`. */
export function webApiPlatformError(response: Record<string, unknown>): WebAPIPlatformError {
  const error = String(response.error);
  return Object.assign(new Error(`An API error occurred: ${error}`), {
    code: ErrorCode.PlatformError,
    data: { ...response, ok: false, error },
  } as const);
}
