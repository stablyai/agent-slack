/**
 * Pure JavaScript LevelDB reader for Chromium Local Storage.
 * Reads SSTable (.ldb) and log (.log) files without native modules.
 *
 * This is a minimal implementation that only supports reading - no writes.
 * Designed for extracting Slack tokens from Chromium-based apps.
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { snappyUncompress } from "hysnappy";

// LevelDB magic number (little-endian): 0xdb4775248b80fb57
const LEVELDB_MAGIC = Buffer.from([0x57, 0xfb, 0x80, 0x8b, 0x24, 0x75, 0x47, 0xdb]);

// Block compression types
const COMPRESSION_NONE = 0;
const COMPRESSION_SNAPPY = 1;

// Log record types
const LOG_RECORD_FULL = 1;
const LOG_RECORD_FIRST = 2;
const LOG_RECORD_MIDDLE = 3;
const LOG_RECORD_LAST = 4;

export type LevelDBEntry = {
  key: Buffer;
  value: Buffer;
};

/**
 * Read a varint from buffer at offset. Returns [value, bytesRead].
 */
function readVarint(buf: Buffer, offset: number): [number, number] {
  let result = 0;
  let shift = 0;
  let bytesRead = 0;

  while (offset + bytesRead < buf.length) {
    const byte = buf[offset + bytesRead]!;
    bytesRead++;
    result |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      return [result, bytesRead];
    }
    shift += 7;
    if (shift >= 35) {
      throw new Error("Varint too long");
    }
  }
  throw new Error("Unexpected end of buffer reading varint");
}

/**
 * Read a varint64 from buffer. For our use case, we only need 32-bit precision.
 */
function readVarint64(buf: Buffer, offset: number): [number, number] {
  let result = 0;
  let shift = 0;
  let bytesRead = 0;

  while (offset + bytesRead < buf.length && bytesRead < 10) {
    const byte = buf[offset + bytesRead]!;
    bytesRead++;
    if (shift < 32) {
      result |= (byte & 0x7f) << shift;
    }
    if ((byte & 0x80) === 0) {
      return [result >>> 0, bytesRead];
    }
    shift += 7;
  }
  throw new Error("Unexpected end of buffer reading varint64");
}

/**
 * Get uncompressed length from Snappy-compressed data.
 * Snappy format starts with uncompressed length as a varint.
 */
function getSnappyUncompressedLength(compressed: Buffer): number {
  const [length] = readVarint(compressed, 0);
  return length;
}

/**
 * Parse a LevelDB block handle (offset + size as varints).
 */
function parseBlockHandle(
  buf: Buffer,
  offset: number,
): { offset: number; size: number; bytesRead: number } {
  const [blockOffset, n1] = readVarint64(buf, offset);
  const [blockSize, n2] = readVarint64(buf, offset + n1);
  return { offset: blockOffset, size: blockSize, bytesRead: n1 + n2 };
}

/**
 * Decompress a block if needed.
 */
function decompressBlock(blockData: Buffer, compressionType: number): Buffer {
  if (compressionType === COMPRESSION_NONE) {
    return blockData;
  }
  if (compressionType === COMPRESSION_SNAPPY) {
    const uncompressedLength = getSnappyUncompressedLength(blockData);
    const result = snappyUncompress(blockData, uncompressedLength);
    return Buffer.from(result);
  }
  throw new Error(`Unknown compression type: ${compressionType}`);
}

/**
 * Parse entries from a data block.
 * LevelDB uses prefix compression within blocks.
 */
function parseDataBlock(block: Buffer): LevelDBEntry[] {
  const entries: LevelDBEntry[] = [];

  if (block.length < 4) {
    return entries;
  }

  // Last 4 bytes are number of restart points
  const numRestarts = block.readUInt32LE(block.length - 4);
  // Restart array is numRestarts * 4 bytes before the count
  const restartsStart = block.length - 4 - numRestarts * 4;

  if (restartsStart < 0) {
    return entries;
  }

  let offset = 0;
  let prevKey = Buffer.alloc(0);

  while (offset < restartsStart) {
    try {
      const [shared, n1] = readVarint(block, offset);
      offset += n1;
      const [nonShared, n2] = readVarint(block, offset);
      offset += n2;
      const [valueLen, n3] = readVarint(block, offset);
      offset += n3;

      if (offset + nonShared + valueLen > restartsStart) {
        break;
      }

      // Build key from shared prefix + new bytes
      const keyDelta = block.subarray(offset, offset + nonShared);
      offset += nonShared;

      const key = Buffer.concat([prevKey.subarray(0, shared), keyDelta]);
      const value = block.subarray(offset, offset + valueLen);
      offset += valueLen;

      // Filter out deletion markers (keys starting with certain internal prefixes)
      // In LevelDB, user keys don't have the sequence number suffix for our read-only case
      entries.push({ key: Buffer.from(key), value: Buffer.from(value) });
      prevKey = key;
    } catch {
      break;
    }
  }

  return entries;
}

/**
 * Parse an SSTable (.ldb or .sst) file and extract all key-value pairs.
 */
async function parseSSTable(filePath: string): Promise<LevelDBEntry[]> {
  const entries: LevelDBEntry[] = [];

  let data: Buffer;
  try {
    data = await readFile(filePath);
  } catch {
    return entries;
  }

  if (data.length < 48) {
    return entries;
  }

  // Read footer (last 48 bytes)
  const footer = data.subarray(-48);

  // Verify magic number (last 8 bytes of footer)
  const magic = footer.subarray(40, 48);
  if (!magic.equals(LEVELDB_MAGIC)) {
    // Not a valid SSTable or different format
    return entries;
  }

  try {
    // Parse metaindex and index block handles from footer
    // Footer format: [metaindex_handle][index_handle][padding][magic]
    const { bytesRead: metaBytes } = parseBlockHandle(footer, 0);
    const indexHandle = parseBlockHandle(footer, metaBytes);

    // Read index block
    const indexBlockStart = indexHandle.offset;
    const indexBlockEnd = indexHandle.offset + indexHandle.size + 5; // +5 for type + crc

    if (indexBlockEnd > data.length - 48) {
      return entries;
    }

    const indexBlockRaw = data.subarray(indexBlockStart, indexBlockEnd);
    const indexCompressionType = indexBlockRaw.at(-5)!;
    const indexBlockData = indexBlockRaw.subarray(0, -5);
    const indexBlock = decompressBlock(indexBlockData, indexCompressionType);

    // Parse index block to get data block locations
    const indexEntries = parseDataBlock(indexBlock);

    // Read each data block
    for (const indexEntry of indexEntries) {
      try {
        // Index entry value contains a block handle
        const blockHandle = parseBlockHandle(indexEntry.value, 0);
        const blockStart = blockHandle.offset;
        const blockEnd = blockHandle.offset + blockHandle.size + 5; // +5 for type + crc

        if (blockEnd > data.length) {
          continue;
        }

        const blockRaw = data.subarray(blockStart, blockEnd);
        const compressionType = blockRaw.at(-5)!;
        const blockData = blockRaw.subarray(0, -5);
        const block = decompressBlock(blockData, compressionType);

        const blockEntries = parseDataBlock(block);
        entries.push(...blockEntries);
      } catch {
        // Skip malformed blocks
        continue;
      }
    }
  } catch {
    // If structured parsing fails, return empty
    return entries;
  }

  return entries;
}

/**
 * Parse a LevelDB log (.log) file for recent writes.
 * Log files contain records that haven't been compacted to SSTables yet.
 */
async function parseLogFile(filePath: string): Promise<LevelDBEntry[]> {
  const entries: LevelDBEntry[] = [];

  let data: Buffer;
  try {
    data = await readFile(filePath);
  } catch {
    return entries;
  }

  const BLOCK_SIZE = 32768;
  let offset = 0;
  let pendingRecord: Buffer[] = [];

  while (offset < data.length) {
    // Records are within 32KB blocks
    const blockOffset = offset % BLOCK_SIZE;
    const remaining = BLOCK_SIZE - blockOffset;

    // Skip to next block if not enough space for header
    if (remaining < 7) {
      offset += remaining;
      continue;
    }

    // Read record header: [crc32: 4][length: 2][type: 1]
    if (offset + 7 > data.length) {
      break;
    }

    const length = data.readUInt16LE(offset + 4);
    const type = data[offset + 6]!;

    if (length === 0 || offset + 7 + length > data.length) {
      offset += remaining;
      pendingRecord = [];
      continue;
    }

    const recordData = data.subarray(offset + 7, offset + 7 + length);
    offset += 7 + length;

    if (type === LOG_RECORD_FULL) {
      pendingRecord = [];
      parseLogBatch(recordData, entries);
    } else if (type === LOG_RECORD_FIRST) {
      pendingRecord = [recordData];
    } else if (type === LOG_RECORD_MIDDLE) {
      if (pendingRecord.length > 0) {
        pendingRecord.push(recordData);
      }
    } else if (type === LOG_RECORD_LAST) {
      if (pendingRecord.length > 0) {
        pendingRecord.push(recordData);
        const fullRecord = Buffer.concat(pendingRecord);
        parseLogBatch(fullRecord, entries);
      }
      pendingRecord = [];
    }
  }

  return entries;
}

/**
 * Parse a write batch from a log record.
 * Batch format: [sequence: 8][count: 4][records...]
 * Record format: [type: 1][key_len: varint][key][value_len: varint][value]
 */
function parseLogBatch(batch: Buffer, entries: LevelDBEntry[]): void {
  if (batch.length < 12) {
    return;
  }

  // Skip sequence (8 bytes) and count (4 bytes)
  let offset = 12;

  while (offset < batch.length) {
    try {
      const recordType = batch[offset]!;
      offset++;

      if (recordType === 1) {
        // Value record
        const [keyLen, n1] = readVarint(batch, offset);
        offset += n1;
        const key = batch.subarray(offset, offset + keyLen);
        offset += keyLen;
        const [valueLen, n2] = readVarint(batch, offset);
        offset += n2;
        const value = batch.subarray(offset, offset + valueLen);
        offset += valueLen;

        entries.push({ key: Buffer.from(key), value: Buffer.from(value) });
      } else if (recordType === 0) {
        // Deletion record - skip
        const [keyLen, n1] = readVarint(batch, offset);
        offset += n1 + keyLen;
      } else {
        // Unknown record type
        break;
      }
    } catch {
      break;
    }
  }
}

/**
 * Read all key-value pairs from a Chromium LevelDB directory.
 * Scans both SSTable (.ldb) files and log (.log) files.
 */
export async function readChromiumLevelDB(dir: string): Promise<LevelDBEntry[]> {
  const entries: LevelDBEntry[] = [];

  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return entries;
  }

  // Parse all .ldb and .sst files
  const sstFiles = files.filter((f) => f.endsWith(".ldb") || f.endsWith(".sst"));
  for (const file of sstFiles) {
    const fileEntries = await parseSSTable(join(dir, file));
    entries.push(...fileEntries);
  }

  // Parse all .log files
  const logFiles = files.filter((f) => f.endsWith(".log"));
  for (const file of logFiles) {
    const fileEntries = await parseLogFile(join(dir, file));
    entries.push(...fileEntries);
  }

  return entries;
}

/**
 * Find all entries containing a substring in their key.
 */
export async function findKeysContaining(dir: string, substring: Buffer): Promise<LevelDBEntry[]> {
  const allEntries = await readChromiumLevelDB(dir);
  return allEntries.filter((entry) => entry.key.includes(substring));
}
