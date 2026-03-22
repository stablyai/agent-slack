import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SlackDownloadError, downloadSlackFile, tryDownloadSlackFile } from "../src/slack/files.ts";
import { downloadMessageFiles } from "../src/cli/message-file-downloads.ts";
import type { SlackAuth } from "../src/slack/client.ts";

const AUTH: SlackAuth = { auth_type: "standard", token: "xoxb-test" };

const originalFetch = globalThis.fetch;

function setFetchMock(fn: (...args: unknown[]) => Promise<Response>) {
  const mocked = mock(fn) as unknown as typeof globalThis.fetch;
  mocked.preconnect = () => {};
  globalThis.fetch = mocked;
  return mocked;
}

function mockFetchOk(body: string | Buffer, contentType = "application/octet-stream") {
  return setFetchMock(() =>
    Promise.resolve(new Response(body, { status: 200, headers: { "content-type": contentType } })),
  );
}

function mockFetchStatus(status: number) {
  return setFetchMock(() => Promise.resolve(new Response(null, { status })));
}

function mockFetchReject(err: Error) {
  return setFetchMock(() => Promise.reject(err));
}

function mockFetchResponse(response: Response) {
  return setFetchMock(() => Promise.resolve(response));
}

describe("downloadSlackFile", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "agent-slack-test-"));
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await rm(tempDir, { recursive: true, force: true });
  });

  test("downloads file and writes to disk", async () => {
    mockFetchOk("hello world");
    const path = await downloadSlackFile({
      auth: AUTH,
      url: "https://files.slack.com/files/test.txt",
      destDir: tempDir,
      preferredName: "out.txt",
    });
    expect(path).toBe(join(tempDir, "out.txt"));
    expect(await readFile(path, "utf8")).toBe("hello world");
  });

  test("returns cached path when file already exists", async () => {
    const existing = join(tempDir, "cached.txt");
    await writeFile(existing, "cached");
    const fetchMock = mockFetchStatus(200);
    const path = await downloadSlackFile({
      auth: AUTH,
      url: "https://files.slack.com/files/cached.txt",
      destDir: tempDir,
      preferredName: "cached.txt",
    });
    expect(path).toBe(existing);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("throws SlackDownloadError on HTTP 404", async () => {
    mockFetchStatus(404);
    await expect(
      downloadSlackFile({
        auth: AUTH,
        url: "https://files.slack.com/files/missing.txt",
        destDir: tempDir,
      }),
    ).rejects.toThrow(SlackDownloadError);
  });

  test("throws SlackDownloadError with httpStatus on HTTP error", async () => {
    mockFetchStatus(401);
    const err = await downloadSlackFile({
      auth: AUTH,
      url: "https://files.slack.com/files/secret.txt",
      destDir: tempDir,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SlackDownloadError);
    expect((err as SlackDownloadError).httpStatus).toBe(401);
  });

  test("throws SlackDownloadError on HTML auth page", async () => {
    mockFetchOk("<html><body>Sign in</body></html>", "text/html");
    await expect(
      downloadSlackFile({
        auth: AUTH,
        url: "https://files.slack.com/files/page.txt",
        destDir: tempDir,
      }),
    ).rejects.toThrow(SlackDownloadError);
  });

  test("throws SlackDownloadError on network error", async () => {
    mockFetchReject(new TypeError("fetch failed"));
    const err = await downloadSlackFile({
      auth: AUTH,
      url: "https://files.slack.com/files/unreachable.txt",
      destDir: tempDir,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SlackDownloadError);
    expect((err as SlackDownloadError).message).toContain("Network error");
  });

  test("throws SlackDownloadError when reading html body fails", async () => {
    mockFetchResponse({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "text/html" }),
      text: async () => {
        throw new TypeError("stream failed");
      },
      arrayBuffer: async () => new ArrayBuffer(0),
    } as unknown as Response);

    const err = await downloadSlackFile({
      auth: AUTH,
      url: "https://files.slack.com/files/page.txt",
      destDir: tempDir,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SlackDownloadError);
    expect((err as SlackDownloadError).message).toContain("Failed to read download response body");
  });

  test("throws SlackDownloadError when reading binary body fails", async () => {
    mockFetchResponse({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "application/octet-stream" }),
      text: async () => "",
      arrayBuffer: async () => {
        throw new TypeError("stream failed");
      },
    } as unknown as Response);

    const err = await downloadSlackFile({
      auth: AUTH,
      url: "https://files.slack.com/files/file.bin",
      destDir: tempDir,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SlackDownloadError);
    expect((err as SlackDownloadError).message).toContain("Failed to read download response body");
  });
});

describe("tryDownloadSlackFile", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "agent-slack-test-"));
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await rm(tempDir, { recursive: true, force: true });
  });

  test("returns ok result on success", async () => {
    mockFetchOk("content");
    const result = await tryDownloadSlackFile({
      auth: AUTH,
      url: "https://files.slack.com/files/good.txt",
      destDir: tempDir,
      preferredName: "good.txt",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.path).toBe(join(tempDir, "good.txt"));
    }
  });

  test("returns failure result on HTTP 404", async () => {
    mockFetchStatus(404);
    const result = await tryDownloadSlackFile({
      auth: AUTH,
      url: "https://files.slack.com/files/missing.txt",
      destDir: tempDir,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.httpStatus).toBe(404);
      expect(result.error).toContain("404");
    }
  });

  test("returns failure result on network error", async () => {
    mockFetchReject(new TypeError("fetch failed"));
    const result = await tryDownloadSlackFile({
      auth: AUTH,
      url: "https://files.slack.com/files/down.txt",
      destDir: tempDir,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("Network error");
    }
  });

  test("propagates disk/write errors", async () => {
    // Create a file where a directory is expected — mkdir will fail with ENOTDIR
    const blockerFile = join(tempDir, "blocker");
    await writeFile(blockerFile, "not a directory");
    mockFetchOk("content");
    await expect(
      tryDownloadSlackFile({
        auth: AUTH,
        url: "https://files.slack.com/files/file.txt",
        destDir: join(blockerFile, "subdir"),
      }),
    ).rejects.toThrow();
  });
});

describe("downloadMessageFiles", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "agent-slack-test-"));
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await rm(tempDir, { recursive: true, force: true });
  });

  test("records canvas auth failures as structured errors", async () => {
    mockFetchOk(
      "<html><head><title>Sign in</title></head><body>Sign in</body></html>",
      "text/html",
    );
    const originalXdg = process.env.XDG_RUNTIME_DIR;
    process.env.XDG_RUNTIME_DIR = tempDir;

    try {
      const result = await downloadMessageFiles({
        auth: AUTH,
        messages: [
          {
            channel_id: "C123",
            ts: "1234567890.000001",
            text: "hello",
            markdown: "hello",
            files: [
              {
                id: "F1",
                name: "canvas",
                mode: "canvas",
                url_private: "https://files.slack.com/files/canvas",
              },
            ],
          },
        ],
      });
      expect(result.F1).toEqual({
        ok: false,
        error: "Downloaded auth/login page instead of canvas content (token may be expired)",
        httpStatus: undefined,
        path: join(tempDir, "agent-slack", "tmp", "downloads", "F1.download-error.txt"),
      });
    } finally {
      process.env.XDG_RUNTIME_DIR = originalXdg;
    }
  });

  test("records non-canvas download failures with a local error path", async () => {
    mockFetchStatus(404);
    const originalXdg = process.env.XDG_RUNTIME_DIR;
    process.env.XDG_RUNTIME_DIR = tempDir;

    try {
      const result = await downloadMessageFiles({
        auth: AUTH,
        messages: [
          {
            channel_id: "C123",
            ts: "1234567890.000001",
            text: "hello",
            markdown: "hello",
            files: [
              {
                id: "F2",
                name: "report.txt",
                mimetype: "text/plain",
                url_private: "https://files.slack.com/files/report",
              },
            ],
          },
        ],
      });
      expect(result.F2).toEqual({
        ok: false,
        error: "Failed to download file (404)",
        httpStatus: 404,
        path: join(tempDir, "agent-slack", "tmp", "downloads", "F2.download-error.txt"),
      });
    } finally {
      process.env.XDG_RUNTIME_DIR = originalXdg;
    }
  });
});
