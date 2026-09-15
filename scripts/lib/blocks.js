// Block-level identity for the vector index (AD-16). A "block" is one unit of
// retrieval: a Logseq list item (with its indented continuation lines) or a
// paragraph. Identity follows Logseq's own rule — an explicit `id:: <uuid>`
// property when the block carries one, otherwise a stable fallback of
// path + blockIndex. The block's *content hash* is tracked separately, so an
// edit to the same slot re-embeds only that block and an unchanged re-save
// re-embeds nothing.
const crypto = require('node:crypto')

const HEADING_RE = /^(#{1,6})\s+(.+?)\s*$/
const BULLET_RE = /^(\s*)[-*+]\s+(.*)$/
const BLOCK_ID_RE = /\bid::\s*([A-Za-z0-9_-]{6,})/

/** Collapses whitespace so a formatting-only rewrite hashes the same. */
function normalizeBlockText (text) {
  return String(text == null ? '' : text).replace(/\s+/g, ' ').trim()
}

/** sha1 hex of a block's normalized content — the diff key for re-embedding. */
function hashBlockText (text) {
  return crypto.createHash('sha1').update(normalizeBlockText(text)).digest('hex')
}

/**
 * Stable identity for a block: an explicit Logseq `id::` when present (so a
 * block keeps its vector when it moves), else `<path>#<index>` (so an
 * unchanged block keeps its vector across reindexes). Not content-addressed —
 * `hashBlockText` is what tells us whether the content under an id changed.
 */
function blockId ({ explicitId, path: filePath, index }) {
  return explicitId ? `id:${explicitId}` : `${filePath}#${index}`
}

/**
 * Splits a page body into blocks in document order. `##`-`######` headings set
 * the heading context for following blocks but are not themselves indexed
 * (they carry no fact of their own). Returns
 * `[{ index, heading, text, explicitId }]`, dropping empty blocks.
 */
function splitBlocks (body) {
  const lines = String(body == null ? '' : body).split(/\r?\n/)
  const blocks = []
  let heading = ''
  let current = null

  const flush = () => {
    if (!current) return
    const text = current.lines.join('\n').trim()
    if (text) {
      const explicit = BLOCK_ID_RE.exec(text)
      blocks.push({
        index: blocks.length,
        heading: current.heading,
        text,
        explicitId: explicit ? explicit[1] : null
      })
    }
    current = null
  }

  for (const line of lines) {
    const h = HEADING_RE.exec(line)
    if (h) {
      flush()
      heading = h[2].trim()
      continue
    }
    const b = BULLET_RE.exec(line)
    if (b) {
      flush()
      current = { heading, lines: [b[2]] }
      continue
    }
    if (!line.trim()) {
      flush()
      continue
    }
    if (!current) current = { heading, lines: [] }
    current.lines.push(line)
  }
  flush()
  return blocks
}

module.exports = {
  splitBlocks,
  blockId,
  hashBlockText,
  normalizeBlockText
}
