// Convert an Office / PDF file into Markdown a Hatch pass can actually read.
//
// A .docx / .xlsx / .pptx is a zip of XML; a .pdf is a binary stream. Fed to
// the LLM as "text" they're noise that costs thousands of tokens and produces
// nothing. This module turns each into compact Markdown — headings, lists and
// tables for Word; one table per sheet for spreadsheets; per-slide text for
// decks; the text layer for PDFs — so the same pages/ → Hatch pipeline works.
//
// extractToMarkdown(absPath, opts) -> { markdown, kind, warnings }
//   kind:      'docx' | 'xlsx' | 'pptx' | 'pdf' | 'csv'
//   warnings:  human-readable notes (a lossy PDF, a dropped sheet, …)
//   throws     UnsupportedFormatError for a type we don't handle (with a hint
//              for the legacy formats: re-save as .docx / .xlsx / .pptx)
//
// Deps, all pure-JS and required lazily so a broken install of one doesn't
// sink the others: mammoth (docx), xlsx (spreadsheets — already a dep), pizzip
// (pptx — already a dep), pdf-parse (pdf).

const fs = require('node:fs')
const path = require('node:path')

// Rows/cols past this are dropped from a sheet with a note — a 50k-row export
// is not something Hatch should try to reason over.
const MAX_SHEET_ROWS = 200
const MAX_SHEET_COLS = 40

class UnsupportedFormatError extends Error {
  constructor (message, ext) {
    super(message)
    this.name = 'UnsupportedFormatError'
    this.ext = ext
  }
}

// Legacy / OpenDocument types we don't convert — mapped to the modern format
// to re-save as. Kept separate from "never heard of it" so the message helps.
const LEGACY_HINTS = {
  '.doc': '.docx',
  '.ppt': '.pptx',
  '.xls': '.xlsx', // .xls is actually handled below; kept here only as a fallback message if SheetJS can't
  '.odt': '.docx',
  '.odp': '.pptx',
  '.ods': '.xlsx',
  '.rtf': '.docx',
  '.pages': '.docx',
  '.key': '.pptx',
  '.numbers': '.xlsx'
}

const SUPPORTED_EXTS = new Set(['.docx', '.xlsx', '.xls', '.xlsm', '.csv', '.tsv', '.pptx', '.pdf'])

/** Is `name`/`path` an Office/PDF file this module knows how to convert? */
function isSupported (name) {
  return SUPPORTED_EXTS.has(path.extname(String(name || '')).toLowerCase())
}

// --- Word -------------------------------------------------------------------

async function docxToMarkdown (absPath) {
  const mammoth = require('mammoth')
  const { value, messages } = await mammoth.convertToMarkdown({ path: absPath })
  const warnings = (messages || [])
    .filter((m) => m.type === 'warning')
    .map((m) => m.message)
  // mammoth leaves runs of blank lines around lists/tables — collapse to two.
  const markdown = value.replace(/\n{3,}/g, '\n\n').trim()
  return { markdown, kind: 'docx', warnings }
}

// --- Spreadsheets ----------------------------------------------------------

function cellText (v) {
  if (v === null || v === undefined) return ''
  if (v instanceof Date) return v.toISOString().slice(0, 10)
  return String(v).replace(/\s+/g, ' ').trim()
}

function mdTable (rows) {
  if (!rows.length) return '_(empty)_'
  const width = Math.min(MAX_SHEET_COLS, Math.max(...rows.map((r) => r.length)))
  const pad = (r) => {
    const cells = r.slice(0, width).map((c) => cellText(c).replace(/\|/g, '\\|'))
    while (cells.length < width) cells.push('')
    return cells
  }
  const header = pad(rows[0])
  const lines = [
    '| ' + header.join(' | ') + ' |',
    '| ' + header.map(() => '---').join(' | ') + ' |'
  ]
  for (const r of rows.slice(1)) lines.push('| ' + pad(r).join(' | ') + ' |')
  return lines.join('\n')
}

/** Trim fully-empty trailing rows and columns from an array-of-arrays. */
function trimGrid (grid) {
  let rows = grid.map((r) => r.map(cellText))
  while (rows.length && rows[rows.length - 1].every((c) => c === '')) rows.pop()
  const lastCol = rows.reduce((max, r) => {
    let i = r.length - 1
    while (i >= 0 && r[i] === '') i--
    return Math.max(max, i)
  }, -1)
  rows = rows.map((r) => r.slice(0, lastCol + 1))
  return rows.filter((r) => r.length)
}

function spreadsheetToMarkdown (absPath, kind) {
  const XLSX = require('xlsx')
  const wb = XLSX.readFile(absPath, { cellDates: true })
  const warnings = []
  const parts = []

  for (const name of wb.SheetNames) {
    const raw = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: null, blankrows: false })
    let rows = trimGrid(raw)
    if (!rows.length) continue

    if (rows.length > MAX_SHEET_ROWS + 1) {
      const dropped = rows.length - MAX_SHEET_ROWS - 1
      rows = rows.slice(0, MAX_SHEET_ROWS + 1)
      warnings.push(`sheet "${name}": kept the first ${MAX_SHEET_ROWS} rows, dropped ${dropped}`)
    }
    if (rows.some((r) => r.length > MAX_SHEET_COLS)) {
      warnings.push(`sheet "${name}": kept the first ${MAX_SHEET_COLS} columns`)
    }

    parts.push(wb.SheetNames.length > 1 ? `## ${name}\n\n${mdTable(rows)}` : mdTable(rows))
  }

  if (!parts.length) return { markdown: '_(the spreadsheet has no non-empty cells)_', kind, warnings }
  return { markdown: parts.join('\n\n'), kind, warnings }
}

// --- PowerPoint ----------------------------------------------------------

// Pull visible text from one slide's XML: every <a:t>…</a:t> run, in order,
// with paragraph (<a:p>) boundaries becoming line breaks.
function slideXmlToLines (xml) {
  const paras = xml.split(/<a:p[\s>]/).slice(1)
  const lines = []
  for (const p of paras) {
    const runs = [...p.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((m) => decodeXml(m[1]))
    const line = runs.join('').replace(/\s+/g, ' ').trim()
    if (line) lines.push(line)
  }
  return lines
}

function decodeXml (s) {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&')
}

function pptxToMarkdown (absPath) {
  const PizZip = require('pizzip')
  const zip = new PizZip(fs.readFileSync(absPath))
  const slideFiles = Object.keys(zip.files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => slideNo(a) - slideNo(b))
  const notesFiles = new Set(Object.keys(zip.files).filter((n) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(n)))

  const warnings = []
  const parts = []
  slideFiles.forEach((file, i) => {
    const n = i + 1
    const lines = slideXmlToLines(zip.files[file].asText())
    const block = [`## Slide ${n}`]
    if (lines.length) block.push('', lines.map((l) => `- ${l}`).join('\n'))

    const notesFile = `ppt/notesSlides/notesSlide${slideNo(file)}.xml`
    if (notesFiles.has(notesFile)) {
      const notes = slideXmlToLines(zip.files[notesFile].asText())
        .filter((l) => l && !/^\d+$/.test(l)) // PowerPoint stuffs the slide number in here
      if (notes.length) block.push('', `_Notes:_ ${notes.join(' ')}`)
    }
    parts.push(block.join('\n'))
  })

  if (!slideFiles.length) warnings.push('no slides found in the deck')
  return { markdown: parts.join('\n\n') || '_(no slide text)_', kind: 'pptx', warnings }
}

function slideNo (name) {
  const m = name.match(/(\d+)\.xml$/)
  return m ? +m[1] : 0
}

// --- PDF -----------------------------------------------------------------

async function pdfToMarkdown (absPath) {
  const pdfParse = require('pdf-parse')
  const data = await pdfParse(fs.readFileSync(absPath))
  const text = String(data.text || '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  const warnings = ['PDF text is extracted from the content layer — tables, columns and scanned pages may come through imperfectly or not at all']
  if (!text) warnings.push('no extractable text — this PDF is likely scanned images (OCR is not done)')
  return { markdown: text || '_(no extractable text)_', kind: 'pdf', warnings, pages: data.numpages }
}

// --- dispatch ----------------------------------------------------------

/**
 * Convert `absPath` to Markdown. Resolves { markdown, kind, warnings }.
 * Throws UnsupportedFormatError for a type this module doesn't handle.
 */
async function extractToMarkdown (absPath) {
  const ext = path.extname(absPath).toLowerCase()
  switch (ext) {
    case '.docx': return docxToMarkdown(absPath)
    case '.xlsx':
    case '.xlsm':
    case '.xls': return spreadsheetToMarkdown(absPath, 'xlsx')
    case '.csv':
    case '.tsv': return spreadsheetToMarkdown(absPath, 'csv')
    case '.pptx': return pptxToMarkdown(absPath)
    case '.pdf': return pdfToMarkdown(absPath)
    default: {
      const hint = LEGACY_HINTS[ext]
      throw new UnsupportedFormatError(
        hint
          ? `${ext} isn't supported — re-save it as ${hint} and drop that instead.`
          : `${ext || 'this file'} isn't a document Kip can read (supported: .docx, .xlsx, .xls, .csv, .pptx, .pdf).`,
        ext)
    }
  }
}

/** The `.md` name a converted `<name>.<ext>` gets: `<name>.md`, ext-stripped. */
function markdownNameFor (filename) {
  const ext = path.extname(filename)
  return filename.slice(0, filename.length - ext.length) + '.md'
}

/**
 * The full Markdown document written into pages/ for a converted file: YAML
 * front-matter recording the origin (so a hatched page can be traced back),
 * then the body. `srcName` is the original file's basename.
 */
function toHatchSource (srcName, { markdown, kind, warnings = [] }) {
  const fm = [
    '---',
    `source: ${JSON.stringify(srcName)}`,
    `source_format: ${kind}`,
    `converted: ${JSON.stringify(new Date().toISOString().slice(0, 10))}`
  ]
  if (warnings.length) {
    fm.push('conversion_notes:')
    for (const w of warnings) fm.push(`  - ${JSON.stringify(w)}`)
  }
  fm.push('---', '')
  return fm.join('\n') + markdown + '\n'
}

/**
 * The Markdown document written for a file Kip can't convert: a reference-only
 * stub naming the original, so the file still gets a traceable page instead of
 * being silently dropped. `srcName` is the original file's basename, `note`
 * is an optional one-line reason (e.g. the UnsupportedFormatError hint).
 */
function toStubSource (srcName, note) {
  const fm = [
    '---',
    `source: ${JSON.stringify(srcName)}`,
    'source_format: binary',
    `converted: ${JSON.stringify(new Date().toISOString().slice(0, 10))}`
  ]
  if (note) {
    fm.push('conversion_notes:')
    fm.push(`  - ${JSON.stringify(note)}`)
  }
  fm.push('---', '')
  const body = `## Source\n\n- Original file: \`${srcName}\`\n- No extractable text for this format. Reference only.\n`
  return fm.join('\n') + body
}

/**
 * Convert `absPath` and write the result as `<dir>/<stem>.md` (or `outPath`).
 * Skips the work when an up-to-date `.md` is already there. Resolves
 * { outPath, kind, warnings, skipped }. Throws for an unsupported format.
 */
async function convertFile (absPath, outPath) {
  const target = outPath || path.join(path.dirname(absPath), markdownNameFor(path.basename(absPath)))
  try {
    if (fs.statSync(target).mtimeMs >= fs.statSync(absPath).mtimeMs) {
      return { outPath: target, kind: null, warnings: [], skipped: true }
    }
  } catch { /* no target yet — convert */ }

  const result = await extractToMarkdown(absPath)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, toHatchSource(path.basename(absPath), result))
  return { outPath: target, kind: result.kind, warnings: result.warnings, skipped: false }
}

module.exports = {
  extractToMarkdown,
  convertFile,
  toHatchSource,
  toStubSource,
  isSupported,
  markdownNameFor,
  SUPPORTED_EXTS,
  LEGACY_HINTS,
  UnsupportedFormatError
}
