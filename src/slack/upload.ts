import { readFile, stat, realpath } from "node:fs/promises";
import { basename } from "node:path";
import type { SlackApiClient } from "./client.ts";
import { asArray, getString, isRecord } from "../lib/object-type-guards.ts";

const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100 MB — Slack's upload limit

/**
 * Stage a local file for Slack's two-step upload: validate the path/size,
 * reserve an upload URL, and POST the bytes. Returns the reserved file id
 * and filename. The caller finalizes the upload via
 * `files.completeUploadExternal` — until then Slack discards a staged but
 * uncompleted upload, so a staging failure leaves nothing behind.
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

/** File ids from a `files.completeUploadExternal` response, in order, if present. */
function completedFileIds(resp: unknown): string[] | undefined {
  if (!isRecord(resp)) {
    return undefined;
  }
  const files = asArray(resp.files).filter(isRecord);
  if (files.length === 0) {
    return undefined;
  }
  return files.map((f) => getString(f.id)).filter((id): id is string => Boolean(id));
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
 * Upload local files for a draft without binding them to a message. Files are
 * staged one at a time; only after every file stages successfully are they
 * completed together in a single `files.completeUploadExternal` call (no
 * `channel_id`, so they stay private). Because completion runs only after all
 * staging succeeded, a failed stage leaves nothing completed and Slack
 * discards the staged-but-uncompleted uploads — no orphaned private files.
 */
export async function uploadFilesForDraft(input: {
  client: SlackApiClient;
  filePaths: string[];
}): Promise<string[]> {
  const staged: { fileId: string; filename: string }[] = [];
  for (const filePath of input.filePaths) {
    staged.push(await stageFileUpload({ client: input.client, filePath }));
  }

  const completeResp = await input.client.api("files.completeUploadExternal", {
    files: staged.map((s) => ({ id: s.fileId, title: s.filename })),
  });

  ensureCompleteOk(completeResp);

  // The completion response is authoritative for the finalized ids; fall back
  // to the ids reserved during staging if Slack omits any.
  const ids = completedFileIds(completeResp);
  return staged.map((s, i) => ids?.[i] ?? s.fileId);
}

/**
 * Best-effort delete of files uploaded for a draft that never got bound to a
 * draft (the drafts.create/update call failed after the upload). Each delete
 * is independent and failures are swallowed — this is cleanup, not a path the
 * caller relies on, so one Slack error must not mask the original failure.
 */
export async function cleanupUploadedDraftFiles(
  client: SlackApiClient,
  fileIds: string[],
): Promise<void> {
  if (fileIds.length === 0) {
    return;
  }
  await Promise.allSettled(fileIds.map((file) => client.api("files.delete", { file })));
}
