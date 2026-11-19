// Data-integrity helpers for DS-BB-012: hash a session artifact whole, and compare a
// byte-exact prefix (the original event frames, which the R-remap must never rewrite)
// against a later copy of the file. The whole-file hash *does* change after a remap
// (a new zstd frame is appended); the original prefix must not.
import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'

export const sha256 = buf => createHash('sha256').update(buf).digest('hex')

// A full snapshot of one session artifact: size, mtime and hashes.
export function snapshotFile(path) {
  const buf = readFileSync(path)
  return {
    path,
    sizeBytes: buf.length,
    sha256Whole: sha256(buf),
    mtimeMs: Math.round(statSync(path).mtimeMs),
  }
}

// Does `after` begin with exactly the bytes of `before` (append-only)?
export function prefixRelation(before, after) {
  if (after.length < before.length) return { appendOnly: false, reason: 'file shrank' }
  const prefix = Buffer.from(after.buffer, after.byteOffset, before.length)
  const identical = sha256(prefix) === sha256(before)
  return {
    appendOnly: identical,
    identicalPrefix: identical,
    appendedBytes: after.length - before.length,
  }
}

// Structural zstd frame scan (magic, header, blocks, 4-byte checksums) — mirrors
// scanZstdFrames in @deepseek-ai/dsh-session-persistence-jsonl so the integrity check
// compares frame ranges the way the runtime itself does, without importing the product.
// The magic is read little-endian (the product constant 4247762216 === 0xfd2fb528).
const ZSTD_MAGIC = 4247762216
export function scanFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) throw new Error(`truncated tail at byte ${start}`)
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error(`invalid frame magic at byte ${offset}`)
    offset += 4
    if (offset === buffer.length) throw new Error(`empty frame at byte ${start}`)
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 24) !== 0) throw new Error(`reserved frame-header bit at byte ${offset - 1}`)
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    offset += remainingHeaderBytes
    for (;;) {
      if (buffer.length - offset < 3) throw new Error(`truncated block header in frame at byte ${start}`)
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = blockHeader >>> 1 & 3
      const blockSize = blockHeader >>> 3
      if (blockType === 3) throw new Error(`reserved block type in frame at byte ${start}`)
      offset += blockType === 1 ? 1 : blockSize
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) throw new Error(`truncated checksum in frame at byte ${start}`)
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return frames
}

// A full snapshot of one session artifact: size, mtime, whole-file hash, and per-frame
// hashes — both the raw frame bytes and the decoded JSONL inside each frame.
export function snapshotArtifact(path, { zstdDecompressSync }) {
  const buf = readFileSync(path)
  const frames = scanFrames(buf).map(range => ({
    start: range.start,
    end: range.end,
    bytes: range.end - range.start,
    sha256Raw: sha256(buf.subarray(range.start, range.end)),
    sha256Decoded: sha256(zstdDecompressSync(buf.subarray(range.start, range.end))),
  }))
  return {
    path,
    sizeBytes: buf.length,
    sha256Whole: sha256(buf),
    mtimeMs: Math.round(statSync(path).mtimeMs),
    frameCount: frames.length,
    frames,
  }
}

export const readAll = readFileSync
