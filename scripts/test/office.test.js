const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const { extractToMarkdown, isSupported, markdownNameFor, UnsupportedFormatError } = require('../lib/office')

const CLI = path.join(__dirname, '..', 'office-extract.js')

let dir
test.before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-test-')) })
test.after(() => fs.rmSync(dir, { recursive: true, force: true }))

// --- fixtures, built with the deps the retrieval layer already ships --------

async function makeDocx (name) {
  const { Document, Packer, Paragraph, HeadingLevel, TextRun } = require('docx')
  const doc = new Document({
    sections: [{
      children: [
        new Paragraph({ text: 'Project Atlas', heading: HeadingLevel.HEADING_1 }),
        new Paragraph({ children: [new TextRun('Kickoff on '), new TextRun({ text: 'March 3', bold: true })] }),
        new Paragraph({ text: 'Risks', heading: HeadingLevel.HEADING_2 }),
        new Paragraph({ text: 'Budget not confirmed', bullet: { level: 0 } })
      ]
    }]
  })
  const p = path.join(dir, name)
  fs.writeFileSync(p, await Packer.toBuffer(doc))
  return p
}

function makeXlsx (name) {
  const XLSX = require('xlsx')
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ['Name', 'Role'], ['Alice', 'PM'], ['Bob', 'Dev'], [], []
  ]), 'Team')
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Q', 'Amount'], ['Q1', 1000]]), 'Budget')
  const p = path.join(dir, name)
  XLSX.writeFile(wb, p)
  return p
}

async function makePptx (name) {
  const PptxGen = require('pptxgenjs')
  const deck = new PptxGen()
  deck.addSlide().addText('Roadmap 2026', { x: 1, y: 1 })
  const s = deck.addSlide()
  s.addText('Q1 — ship sync', { x: 1, y: 1 })
  s.addNotes('Dropbox first')
  const p = path.join(dir, name)
  await deck.writeFile({ fileName: p })
  return p
}

/** Smallest PDF with an extractable text layer, built by hand. */
function makePdf (name) {
  const objs = []
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>'
  objs[2] = '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'
  objs[3] = '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>'
  const stream = 'BT /F1 18 Tf 20 150 Td (Hello from a PDF.) Tj 0 -24 Td (Second line here.) Tj ET'
  objs[4] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`
  objs[5] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  let pdf = '%PDF-1.4\n'
  const off = []
  for (let i = 1; i <= 5; i++) { off[i] = pdf.length; pdf += `${i} 0 obj\n${objs[i]}\nendobj\n` }
  const xref = pdf.length
  pdf += 'xref\n0 6\n0000000000 65535 f \n'
  for (let i = 1; i <= 5; i++) pdf += `${String(off[i]).padStart(10, '0')} 00000 n \n`
  pdf += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`
  const p = path.join(dir, name)
  fs.writeFileSync(p, pdf, 'latin1')
  return p
}

// --- extractToMarkdown ------------------------------------------------------

test('docx → markdown keeps headings, bold and bullets', async () => {
  const { markdown, kind, warnings } = await extractToMarkdown(await makeDocx('a.docx'))
  assert.equal(kind, 'docx')
  assert.match(markdown, /^# Project Atlas/m)
  assert.match(markdown, /## Risks/)
  assert.match(markdown, /- Budget not confirmed/)
  assert.match(markdown, /March 3/)
  assert.ok(Array.isArray(warnings))
})

test('xlsx → one markdown table per non-empty sheet, blank rows/cols trimmed', async () => {
  const { markdown, kind } = await extractToMarkdown(makeXlsx('a.xlsx'))
  assert.equal(kind, 'xlsx')
  assert.match(markdown, /## Team/)
  assert.match(markdown, /## Budget/)
  assert.match(markdown, /\| Name \| Role \|/)
  assert.match(markdown, /\| Alice \| PM \|/)
  // the two trailing empty rows and the padding column are gone
  assert.doesNotMatch(markdown, /\|\s*\|\s*\|\s*\|/)
})

test('csv → a single markdown table, no sheet heading', async () => {
  const p = path.join(dir, 'n.csv')
  fs.writeFileSync(p, 'topic,owner\nonboarding,Alice\nsecurity,Bob\n')
  const { markdown, kind } = await extractToMarkdown(p)
  assert.equal(kind, 'csv')
  assert.doesNotMatch(markdown, /^## /m)
  assert.match(markdown, /\| topic \| owner \|/)
  assert.match(markdown, /\| security \| Bob \|/)
})

test('pptx → per-slide bullets plus speaker notes', async () => {
  const { markdown, kind } = await extractToMarkdown(await makePptx('a.pptx'))
  assert.equal(kind, 'pptx')
  assert.match(markdown, /## Slide 1/)
  assert.match(markdown, /- Roadmap 2026/)
  assert.match(markdown, /## Slide 2/)
  assert.match(markdown, /- Q1 — ship sync/)
  assert.match(markdown, /_Notes:_ Dropbox first/)
})

test('pdf → the text layer, with a fidelity warning', () => {
  // via the CLI (a fresh process): pdf-parse bundles an old pdf.js whose
  // global state doesn't survive sharing a process with the other loaders.
  const src = makePdf('a.pdf')
  const res = JSON.parse(execFileSync('node', [CLI, src, '--json'], { encoding: 'utf8' }))
  assert.equal(res.ok, true)
  assert.equal(res.kind, 'pdf')
  assert.ok(res.warnings.some((w) => /content layer/.test(w)))
  const md = fs.readFileSync(res.output, 'utf8')
  assert.match(md, /Hello from a PDF\./)
  assert.match(md, /Second line here\./)
})

test('a legacy format throws UnsupportedFormatError with a re-save hint', async () => {
  const p = path.join(dir, 'old.doc')
  fs.writeFileSync(p, 'stub')
  await assert.rejects(() => extractToMarkdown(p), (err) => {
    assert.ok(err instanceof UnsupportedFormatError)
    assert.equal(err.ext, '.doc')
    assert.match(err.message, /re-save it as \.docx/)
    return true
  })
})

test('an unknown extension throws with the supported list', async () => {
  const p = path.join(dir, 'x.foo')
  fs.writeFileSync(p, 'stub')
  await assert.rejects(() => extractToMarkdown(p), /supported: \.docx/)
})

test('isSupported / markdownNameFor', () => {
  assert.equal(isSupported('report.DOCX'), true)
  assert.equal(isSupported('a.pdf'), true)
  assert.equal(isSupported('notes.md'), false)
  assert.equal(isSupported('archive.doc'), false)
  assert.equal(markdownNameFor('Q3 Report.docx'), 'Q3 Report.md')
  assert.equal(markdownNameFor('data.xlsx'), 'data.md')
})

// --- the CLI --------------------------------------------------------------

test('office-extract CLI writes <name>.md with provenance front-matter', async () => {
  const src = await makeDocx('cli.docx')
  const out = execFileSync('node', [CLI, src, '--json'], { encoding: 'utf8' })
  const res = JSON.parse(out)
  assert.equal(res.ok, true)
  assert.equal(res.kind, 'docx')
  assert.equal(res.output, path.join(dir, 'cli.md'))
  const md = fs.readFileSync(res.output, 'utf8')
  assert.match(md, /^---\n/)
  assert.match(md, /source: "cli\.docx"/)
  assert.match(md, /source_format: docx/)
  assert.match(md, /# Project Atlas/)
})

test('office-extract CLI --stdout prints markdown and does not write', async () => {
  const src = makeXlsx('so.xlsx')
  const out = execFileSync('node', [CLI, src, '--stdout'], { encoding: 'utf8' })
  assert.match(out, /## Team/)
  assert.equal(fs.existsSync(path.join(dir, 'so.md')), false)
})

test('office-extract CLI --json reports an unsupported file as { ok:false }, exit 0', () => {
  const src = path.join(dir, 'bad.rtf')
  fs.writeFileSync(src, 'stub')
  const res = JSON.parse(execFileSync('node', [CLI, src, '--json'], { encoding: 'utf8' }))
  assert.equal(res.ok, false)
  assert.equal(res.ext, '.rtf')
})

test('office-extract CLI without --json exits 1 on an unsupported file', () => {
  const src = path.join(dir, 'bad2.rtf')
  fs.writeFileSync(src, 'stub')
  assert.throws(() => execFileSync('node', [CLI, src], { encoding: 'utf8', stdio: 'pipe' }),
    (err) => err.status === 1)
})
