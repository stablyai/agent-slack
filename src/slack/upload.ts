import { readFile, stat, realpath } from "node:fs/promises";
import { basename } from "node:path";
import type { SlackApiClient } from "./client.ts";
import { asArray, getString, isRecord } from "../lib/object-type-guards.ts";

const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100 MB — Slack's upload limit

/**
 * Stage a local file for Slack's two-step upload: validate the path/size,
 * reserve an upload URL, and POST the bytes. Returns the reserved file id
 * and filename. The caller decides how to finalize the upload — bound to a
 * message (`uploadLocalFileToSlack`) or left as a standalone file id for a
 * draft (`uploadFileForDraft`).
 */
async function stageFileUpload(input: {
  client: SlackApiClient;
  filePath: string;
}): Promise<{ fileId: string; filename: string }> {
  const resolvedPath = await realpath(input.filePath);
  const fileStats = await stat(resolvedPath);
  if (!fileStats.isFile()) {
    throw new Error(`Attachment path is not a file: ${input.filePath}`);
  }
  if (fileStats.size > MAX_FILE_SIZE) {
    throw new Error(
      `File too large (${Math.round(fileStats.size / 1024 / 1024)}MB). Slack allows up to 100MB.`,
    );
  }

  const bytes = await readFile(resolvedPath);
  const filename = basename(resolvedPath);

  const uploadInitResp = await input.client.api("files.getUploadURLExternal", {
    filename,
    length: bytes.length,
  });

  if (isRecord(uploadInitResp) && uploadInitResp.ok === false) {
    const errMsg = typeof uploadInitResp.error === "string" ? uploadInitResp.error : "unknown";
    throw new Error(`Slack files.getUploadURLExternal failed: ${errMsg}`);
  }

  const uploadUrl = getString(uploadInitResp.upload_url);
  const fileId = getString(uploadInitResp.file_id);
  if (!uploadUrl || !fileId) {
    throw new Error("Slack did not return an upload URL for file attachment");
  }

  const uploadResp = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(bytes.length),
    },
    body: bytes,
  });
  if (!uploadResp.ok) {
    const body = await uploadResp.text().catch(() => "");
    throw new Error(
      `Failed to upload attachment bytes (HTTP ${uploadResp.status})${body ? `: ${body}` : ""}`,
    );
  }

  return { fileId, filename };
}

function ensureCompleteOk(resp: unknown): void {
  if (!isRecord(resp) || resp.ok !== true) {
    const errMsg = isRecord(resp) && typeof resp.error === "string" ? resp.error : "unknown";
    throw new Error(`Slack files.completeUploadExternal failed: ${errMsg}`);
  }
}

/** First file id from a `files.completeUploadExternal` response, if present. */
function completedFileId(resp: unknown): string | undefined {
  if (!isRecord(resp)) {
    return undefined;
  }
  const files = asArray(resp.files).filter(isRecord);
  return getString(files[0]?.id) ?? undefined;
}

/**
 * Upload a local file and attach it to a Slack message in one shot. The
 * completion call binds the file to `channelId` (and optionally the thread),
 * so the file posts with `initialComment` immediately.
 */
export async function uploadLocalFileToSlack(input: {
  client: SlackApiClient;
  channelId: string;
  filePath: string;
  threadTs?: string;
  initialComment?: string;
}): Promise<void> {
  const { fileId, filename } = await stageFileUpload({
    client: input.client,
    filePath: input.filePath,
  });

  const completeResp = await input.client.api("files.completeUploadExternal", {
    files: [{ id: fileId, title: filename }],
    channel_id: input.channelId,
    thread_ts: input.threadTs,
    initial_comment: input.initialComment?.trim() || undefined,
  });

  ensureCompleteOk(completeResp);
}

/**
 * Upload a local file for a draft without binding it to a message. The
 * completion call omits `channel_id` (the file stays private), and the
 * returned file id is wired into the draft's `file_ids` by the caller.
 */
export async function uploadFileForDraft(input: {
  client: SlackApiClient;
  filePath: string;
}): Promise<string> {
  const { fileId, filename } = await stageFileUpload({
    client: input.client,
    filePath: input.filePath,
  });

  const completeResp = await input.client.api("files.completeUploadExternal", {
    files: [{ id: fileId, title: filename }],
  });

  ensureCompleteOk(completeResp);

  // The completion response is authoritative for the finalized file id; fall
  // back to the id reserved during staging if Slack omits it.
  return completedFileId(completeResp) ?? fileId;
}
