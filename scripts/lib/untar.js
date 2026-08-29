// Minimal npm-tarball (.tgz) extractor — pure Node, zero deps.
//
// An npm package tarball is gzip(tar(...)) where every path is under a
// single top-level "package/" directory (npm convention). This reads that
// format well enough to unpack a connector package (a package.json + a
// small JS entry, no binaries): ustar headers, regular files only, the
// leading dir stripped. Everything else (dirs, symlinks, pax/GNU extension
// records) is skipped.
//
// It is deliberately strict about where bytes land — path traversal, absolute
// paths, oversized or too-many entries all throw. The connector allowlist in
// connectors.js is the trust boundary; this is defence in depth.

const zlib = require('node:zlib')
const fs = require('node:fs')
const path = require('node:path')

const BLOCK = 512
const MAX_FILES = 500
const MAX_TOTAL_BYTES = 32 * 1024 * 1024
const MAX_FILE_BYTES = 16 * 1024 * 1024

const TYPE_REGULAR = new Set([0, 0x30]) // '\0' (old tar) or '0' (ustar) = regular file

function readString (buf, off, len) {
  return buf.toString('utf8', off, off + len).replace(/\0.*$/s, '')
}

function readOctal (buf, off, len) {
  const s = buf.toString('ascii', off, off + len).replace(/\0.*$/s, '').trim()
  return s ? parseInt(s, 8) || 0 : 0
}

/**
 * Unpacks `tgzBuffer` into `destDir`, stripping the leading path component
 * ("package/"). Returns the list of relative paths written. Throws on a
 * malformed archive, a path that would escape destDir, or size/count caps.
 */
function extractNpmTarball (tgzBuffer, destDir) {
  let tar
  try {
    tar = zlib.gunzipSync(tgzBuffer)
  } catch {
    throw new Error('not a gzipped tarball (.tgz expected)')
  }

  const root = path.resolve(destDir)
  const written = []
  let offset = 0
  let total = 0

  while (offset + BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + BLOCK)
    if (header.every((b) => b === 0)) break // end-of-archive marker

    const rawName = readString(header, 0, 100)
    const prefix = readString(header, 345, 155)
    const name = prefix ? `${prefix}/${rawName}` : rawName
    const size = readOctal(header, 124, 12)
    const typeflag = header[156]

    offset += BLOCK
    const dataStart = offset
    offset += Math.ceil(size / BLOCK) * BLOCK

    if (!TYPE_REGULAR.has(typeflag) || !name) continue

    // strip the single leading directory (npm's "package/")
    const rel = name.replace(/^[^/]+\//, '')
    if (!rel) continue
    if (rel.split('/').includes('..') || path.isAbsolute(rel)) {
      throw new Error(`unsafe path in tarball: ${name}`)
    }

    if (written.length + 1 > MAX_FILES) throw new Error('tarball has too many files')
    total += size
    if (size > MAX_FILE_BYTES || total > MAX_TOTAL_BYTES) throw new Error('tarball is too large')

    const dest = path.resolve(root, rel)
    if (dest !== root && !dest.startsWith(root + path.sep)) {
      throw new Error(`unsafe path in tarball: ${name}`)
    }

    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.writeFileSync(dest, tar.subarray(dataStart, dataStart + size))
    written.push(rel)
  }

  if (written.length === 0) throw new Error('tarball contained no files')
  return written
}

module.exports = { extractNpmTarball }
