import type { MultiFileArtifactBundle } from '../types/multiFileArtifact';
import { normalizeAndValidateArtifactPath, ArtifactPathSecurityError } from './artifactPathSecurity';

// CRC-32 lookup table (IEEE 802.3)
const CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let k = 0; k < 8; k++) {
    c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  }
  CRC_TABLE[i] = c >>> 0;
}

export function computeCrc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const MAX_ZIP_UNCOMPRESSED_BYTES = 50 * 1024 * 1024; // 50MB
const MAX_ZIP_FILE_COUNT = 500;

interface ZipFileEntry {
  path: string;
  data: Uint8Array;
  crc: number;
  offset: number;
}

/**
 * Creates a valid, uncompressed standard PKZip archive buffer from a MultiFileArtifactBundle.
 * Fully compatible with standard unzip utilities and browser Blob downloads.
 */
export function generateProjectZipArchive(bundle: MultiFileArtifactBundle): Uint8Array {
  const encoder = new TextEncoder();
  const fileEntries: ZipFileEntry[] = [];
  let totalBytes = 0;

  // Add all files from bundle
  const sortedPaths = Object.keys(bundle.files).sort();

  if (sortedPaths.length > MAX_ZIP_FILE_COUNT) {
    throw new ArtifactPathSecurityError(`Too many files for ZIP export (${sortedPaths.length} > ${MAX_ZIP_FILE_COUNT})`);
  }

  for (const path of sortedPaths) {
    const validPath = normalizeAndValidateArtifactPath(path);
    const content = bundle.files[path]?.content || '';
    const bytes = encoder.encode(content);
    totalBytes += bytes.length;

    if (totalBytes > MAX_ZIP_UNCOMPRESSED_BYTES) {
      throw new ArtifactPathSecurityError('Project bundle exceeds maximum archive size of 50MB');
    }

    fileEntries.push({
      path: validPath,
      data: bytes,
      crc: computeCrc32(bytes),
      offset: 0
    });
  }

  // Include deterministic project-manifest.json
  const manifestBytes = encoder.encode(JSON.stringify(bundle.manifest, null, 2));
  fileEntries.push({
    path: 'project-manifest.json',
    data: manifestBytes,
    crc: computeCrc32(manifestBytes),
    offset: 0
  });

  // Calculate buffer size
  let localHeadersSize = 0;
  let centralDirSize = 0;

  for (const entry of fileEntries) {
    const pathBytes = encoder.encode(entry.path);
    localHeadersSize += 30 + pathBytes.length + entry.data.length;
    centralDirSize += 46 + pathBytes.length;
  }

  const endRecordSize = 22;
  const totalArchiveSize = localHeadersSize + centralDirSize + endRecordSize;

  const buffer = new Uint8Array(totalArchiveSize);
  const view = new DataView(buffer.buffer);
  let cursor = 0;

  // 1. Write Local File Headers & File Data
  for (const entry of fileEntries) {
    entry.offset = cursor;
    const pathBytes = encoder.encode(entry.path);

    // Signature 0x04034b50
    view.setUint32(cursor, 0x04034b50, true); cursor += 4;
    view.setUint16(cursor, 20, true); cursor += 2; // version needed
    view.setUint16(cursor, 0x0800, true); cursor += 2; // UTF-8 flag
    view.setUint16(cursor, 0, true); cursor += 2; // compression = 0 (STORE)
    view.setUint16(cursor, 0x4800, true); cursor += 2; // mod time (10:00:00)
    view.setUint16(cursor, 0x5421, true); cursor += 2; // mod date (2026-01-01)
    view.setUint32(cursor, entry.crc, true); cursor += 4;
    view.setUint32(cursor, entry.data.length, true); cursor += 4; // compressed
    view.setUint32(cursor, entry.data.length, true); cursor += 4; // uncompressed
    view.setUint16(cursor, pathBytes.length, true); cursor += 2;
    view.setUint16(cursor, 0, true); cursor += 2; // extra length

    buffer.set(pathBytes, cursor); cursor += pathBytes.length;
    buffer.set(entry.data, cursor); cursor += entry.data.length;
  }

  // 2. Write Central Directory Headers
  const centralDirStartOffset = cursor;

  for (const entry of fileEntries) {
    const pathBytes = encoder.encode(entry.path);

    // Signature 0x02014b50
    view.setUint32(cursor, 0x02014b50, true); cursor += 4;
    view.setUint16(cursor, 20, true); cursor += 2; // version made by
    view.setUint16(cursor, 20, true); cursor += 2; // version needed
    view.setUint16(cursor, 0x0800, true); cursor += 2; // UTF-8 flag
    view.setUint16(cursor, 0, true); cursor += 2; // compression = 0
    view.setUint16(cursor, 0x4800, true); cursor += 2;
    view.setUint16(cursor, 0x5421, true); cursor += 2;
    view.setUint32(cursor, entry.crc, true); cursor += 4;
    view.setUint32(cursor, entry.data.length, true); cursor += 4;
    view.setUint32(cursor, entry.data.length, true); cursor += 4;
    view.setUint16(cursor, pathBytes.length, true); cursor += 2;
    view.setUint16(cursor, 0, true); cursor += 2; // extra len
    view.setUint16(cursor, 0, true); cursor += 2; // comment len
    view.setUint16(cursor, 0, true); cursor += 2; // disk num start
    view.setUint16(cursor, 0, true); cursor += 2; // internal attr
    view.setUint32(cursor, 0o100644 << 16, true); cursor += 4; // external attr
    view.setUint32(cursor, entry.offset, true); cursor += 4;

    buffer.set(pathBytes, cursor); cursor += pathBytes.length;
  }

  const centralDirLength = cursor - centralDirStartOffset;

  // 3. Write End of Central Directory Record
  // Signature 0x06054b50
  view.setUint32(cursor, 0x06054b50, true); cursor += 4;
  view.setUint16(cursor, 0, true); cursor += 2; // disk number
  view.setUint16(cursor, 0, true); cursor += 2; // disk with CD start
  view.setUint16(cursor, fileEntries.length, true); cursor += 2;
  view.setUint16(cursor, fileEntries.length, true); cursor += 2;
  view.setUint32(cursor, centralDirLength, true); cursor += 4;
  view.setUint32(cursor, centralDirStartOffset, true); cursor += 4;
  view.setUint16(cursor, 0, true); cursor += 2; // comment length

  return buffer;
}
