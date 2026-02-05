import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { readChromiumLevelDB, findKeysContaining } from "../src/lib/leveldb-reader.ts";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TEST_DIR = join(tmpdir(), `leveldb-test-${Date.now()}`);

type TestEntry = { key: string; value: string };
type TestFileOpts = { dir: string; filename: string; entries: TestEntry[] };

// Create a minimal valid LevelDB SSTable for testing
// This is a hand-crafted SSTable with known key-value pairs
async function createTestSSTable({ dir, filename, entries }: TestFileOpts) {
  // Build a minimal SSTable with uncompressed blocks
  const dataBlockEntries: Buffer[] = [];
  let prevKey = Buffer.alloc(0);

  for (const { key, value } of entries) {
    const keyBuf = Buffer.from(key);
    const valueBuf = Buffer.from(value);

    // Calculate shared prefix with previous key
    let shared = 0;
    while (
      shared < prevKey.length &&
      shared < keyBuf.length &&
      prevKey[shared] === keyBuf[shared]
    ) {
      shared++;
    }

    // Entry: [shared: varint][non_shared: varint][value_len: varint][key_delta][value]
    const nonShared = keyBuf.length - shared;
    const entry = Buffer.concat([
      encodeVarint(shared),
      encodeVarint(nonShared),
      encodeVarint(valueBuf.length),
      keyBuf.subarray(shared),
      valueBuf,
    ]);
    dataBlockEntries.push(entry);
    prevKey = keyBuf;
  }

  // Data block: [entries...][restart: uint32 = 0][num_restarts: uint32 = 1]
  const restarts = Buffer.alloc(8);
  restarts.writeUInt32LE(0, 0); // First restart at offset 0
  restarts.writeUInt32LE(1, 4); // 1 restart point
  const dataBlockContent = Buffer.concat([...dataBlockEntries, restarts]);

  // Add compression type (0 = none) and CRC placeholder
  const dataBlock = Buffer.concat([dataBlockContent, Buffer.from([0x00, 0, 0, 0, 0])]);
  const dataBlockOffset = 0;
  const dataBlockSize = dataBlockContent.length;

  // Index block: single entry pointing to the data block
  // Key is the last key in the data block, value is the block handle
  const lastKey = entries.length > 0 ? Buffer.from(entries.at(-1)!.key) : Buffer.alloc(0);
  const blockHandle = Buffer.concat([encodeVarint(dataBlockOffset), encodeVarint(dataBlockSize)]);

  const indexEntry = Buffer.concat([
    encodeVarint(0), // shared = 0
    encodeVarint(lastKey.length),
    encodeVarint(blockHandle.length),
    lastKey,
    blockHandle,
  ]);

  const indexRestarts = Buffer.alloc(8);
  indexRestarts.writeUInt32LE(0, 0);
  indexRestarts.writeUInt32LE(1, 4);
  const indexBlockContent = Buffer.concat([indexEntry, indexRestarts]);
  const indexBlock = Buffer.concat([indexBlockContent, Buffer.from([0x00, 0, 0, 0, 0])]);

  const indexBlockOffset = dataBlock.length;
  const indexBlockSize = indexBlockContent.length;

  // Metaindex block (empty)
  const metaindexRestarts = Buffer.alloc(8);
  metaindexRestarts.writeUInt32LE(0, 0);
  metaindexRestarts.writeUInt32LE(1, 4);
  const metaindexBlockContent = metaindexRestarts;
  const metaindexBlock = Buffer.concat([metaindexBlockContent, Buffer.from([0x00, 0, 0, 0, 0])]);

  const metaindexBlockOffset = dataBlock.length + indexBlock.length;
  const metaindexBlockSize = metaindexBlockContent.length;

  // Footer: [metaindex_handle][index_handle][padding to 40 bytes][magic 8 bytes]
  const metaindexHandle = Buffer.concat([
    encodeVarint(metaindexBlockOffset),
    encodeVarint(metaindexBlockSize),
  ]);
  const indexHandle = Buffer.concat([encodeVarint(indexBlockOffset), encodeVarint(indexBlockSize)]);

  const footerContent = Buffer.concat([metaindexHandle, indexHandle]);
  const padding = Buffer.alloc(40 - footerContent.length);
  const magic = Buffer.from([0x57, 0xfb, 0x80, 0x8b, 0x24, 0x75, 0x47, 0xdb]);
  const footer = Buffer.concat([footerContent, padding, magic]);

  // Full SSTable
  const sstable = Buffer.concat([dataBlock, indexBlock, metaindexBlock, footer]);

  await writeFile(join(dir, filename), sstable);
}

// Create a LevelDB log file with write batch records
async function createTestLogFile({ dir, filename, entries }: TestFileOpts) {
  // Log record format: [crc32: 4][length: 2][type: 1][data: length]
  // Write batch format: [sequence: 8][count: 4][records...]
  // Record format: [type: 1][key_len: varint][key][value_len: varint][value]

  const records: Buffer[] = [];
  for (const { key, value } of entries) {
    const keyBuf = Buffer.from(key);
    const valueBuf = Buffer.from(value);
    records.push(
      Buffer.concat([
        Buffer.from([0x01]), // Value record type
        encodeVarint(keyBuf.length),
        keyBuf,
        encodeVarint(valueBuf.length),
        valueBuf,
      ]),
    );
  }

  const sequence = Buffer.alloc(8);
  sequence.writeBigUInt64LE(1n, 0);
  const count = Buffer.alloc(4);
  count.writeUInt32LE(entries.length, 0);

  const batchData = Buffer.concat([sequence, count, ...records]);

  // Wrap in log record (type 1 = FULL)
  const header = Buffer.alloc(7);
  header.writeUInt32LE(0, 0); // CRC placeholder
  header.writeUInt16LE(batchData.length, 4);
  header[6] = 0x01; // FULL record type

  const logFile = Buffer.concat([header, batchData]);
  await writeFile(join(dir, filename), logFile);
}

function encodeVarint(value: number): Buffer {
  const bytes: number[] = [];
  while (value > 0x7f) {
    bytes.push((value & 0x7f) | 0x80);
    value >>>= 7;
  }
  bytes.push(value);
  return Buffer.from(bytes);
}

describe("leveldb-reader", () => {
  beforeAll(async () => {
    await mkdir(TEST_DIR, { recursive: true });
  });

  afterAll(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  describe("readChromiumLevelDB", () => {
    test("returns empty array for non-existent directory", async () => {
      const entries = await readChromiumLevelDB("/non/existent/path");
      expect(entries).toEqual([]);
    });

    test("returns empty array for empty directory", async () => {
      const emptyDir = join(TEST_DIR, "empty");
      await mkdir(emptyDir, { recursive: true });
      const entries = await readChromiumLevelDB(emptyDir);
      expect(entries).toEqual([]);
    });

    test("reads entries from SSTable files", async () => {
      const sstDir = join(TEST_DIR, "sst-test");
      await mkdir(sstDir, { recursive: true });

      await createTestSSTable({
        dir: sstDir,
        filename: "000001.ldb",
        entries: [
          { key: "key1", value: "value1" },
          { key: "key2", value: "value2" },
          { key: "key3", value: "value3" },
        ],
      });

      const entries = await readChromiumLevelDB(sstDir);
      expect(entries.length).toBe(3);
      expect(entries[0]!.key.toString()).toBe("key1");
      expect(entries[0]!.value.toString()).toBe("value1");
      expect(entries[1]!.key.toString()).toBe("key2");
      expect(entries[1]!.value.toString()).toBe("value2");
      expect(entries[2]!.key.toString()).toBe("key3");
      expect(entries[2]!.value.toString()).toBe("value3");
    });

    test("reads entries from log files", async () => {
      const logDir = join(TEST_DIR, "log-test");
      await mkdir(logDir, { recursive: true });

      await createTestLogFile({
        dir: logDir,
        filename: "000001.log",
        entries: [
          { key: "logkey1", value: "logvalue1" },
          { key: "logkey2", value: "logvalue2" },
        ],
      });

      const entries = await readChromiumLevelDB(logDir);
      expect(entries.length).toBe(2);
      expect(entries[0]!.key.toString()).toBe("logkey1");
      expect(entries[0]!.value.toString()).toBe("logvalue1");
    });

    test("reads from both SSTable and log files", async () => {
      const mixedDir = join(TEST_DIR, "mixed-test");
      await mkdir(mixedDir, { recursive: true });

      await createTestSSTable({
        dir: mixedDir,
        filename: "000001.ldb",
        entries: [{ key: "sst_key", value: "sst_value" }],
      });

      await createTestLogFile({
        dir: mixedDir,
        filename: "000002.log",
        entries: [{ key: "log_key", value: "log_value" }],
      });

      const entries = await readChromiumLevelDB(mixedDir);
      expect(entries.length).toBe(2);

      const keys = entries.map((e) => e.key.toString());
      expect(keys).toContain("sst_key");
      expect(keys).toContain("log_key");
    });

    test("handles .sst file extension", async () => {
      const sstDir = join(TEST_DIR, "sst-ext-test");
      await mkdir(sstDir, { recursive: true });

      await createTestSSTable({
        dir: sstDir,
        filename: "000001.sst",
        entries: [{ key: "sst_key", value: "sst_value" }],
      });

      const entries = await readChromiumLevelDB(sstDir);
      expect(entries.length).toBe(1);
      expect(entries[0]!.key.toString()).toBe("sst_key");
    });
  });

  describe("findKeysContaining", () => {
    test("filters entries by key substring", async () => {
      const filterDir = join(TEST_DIR, "filter-test");
      await mkdir(filterDir, { recursive: true });

      await createTestSSTable({
        dir: filterDir,
        filename: "000001.ldb",
        entries: [
          { key: "_https://app.slack.com localConfig_v2", value: '{"teams":{}}' },
          { key: "_https://app.slack.com otherKey", value: "other" },
          { key: "_https://app.slack.com localConfig_v3", value: '{"teams":{}}' },
        ],
      });

      const matches = await findKeysContaining(filterDir, Buffer.from("localConfig_v"));
      expect(matches.length).toBe(2);

      const keys = matches.map((e) => e.key.toString());
      expect(keys.every((k) => k.includes("localConfig_v"))).toBe(true);
    });

    test("returns empty array when no matches", async () => {
      const noMatchDir = join(TEST_DIR, "no-match-test");
      await mkdir(noMatchDir, { recursive: true });

      await createTestSSTable({
        dir: noMatchDir,
        filename: "000001.ldb",
        entries: [
          { key: "key1", value: "value1" },
          { key: "key2", value: "value2" },
        ],
      });

      const matches = await findKeysContaining(noMatchDir, Buffer.from("nonexistent"));
      expect(matches.length).toBe(0);
    });
  });

  describe("edge cases", () => {
    test("handles invalid SSTable (wrong magic)", async () => {
      const badDir = join(TEST_DIR, "bad-magic");
      await mkdir(badDir, { recursive: true });

      // Create a file with invalid magic number
      const badFile = Buffer.alloc(100);
      badFile.fill(0);
      await writeFile(join(badDir, "000001.ldb"), badFile);

      const entries = await readChromiumLevelDB(badDir);
      expect(entries).toEqual([]);
    });

    test("handles empty SSTable file", async () => {
      const emptyFileDir = join(TEST_DIR, "empty-file");
      await mkdir(emptyFileDir, { recursive: true });

      await writeFile(join(emptyFileDir, "000001.ldb"), Buffer.alloc(0));

      const entries = await readChromiumLevelDB(emptyFileDir);
      expect(entries).toEqual([]);
    });

    test("handles SSTable smaller than footer size", async () => {
      const smallDir = join(TEST_DIR, "small-file");
      await mkdir(smallDir, { recursive: true });

      await writeFile(join(smallDir, "000001.ldb"), Buffer.alloc(20));

      const entries = await readChromiumLevelDB(smallDir);
      expect(entries).toEqual([]);
    });
  });
});
