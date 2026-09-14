// docx skill — writes a .docx into <coop>/exports/ and prints its path.
//
//   content mode  (input.content)  — build from scratch with the `docx` package
//   template mode (input.template) — fill a .docx's {tags} with docxtemplater
//
// A sandboxed skill holds no vault access (kip#105): the template's bytes come
// from the parent over the `read_vault_file` hostcall, which resolves the path
// against the real vault root and refuses anything that escapes it. The
// direct-`fs` fallback below is only for the legacy `scripts/lib/skills.js` CLI
// runner, which predates the sandbox and provides no `globalThis.kip`; it
// enforces the same containment rule.
//
// Deps (pure JS): docx, docxtemplater, pizzip. Required lazily so a broken
// install of one doesn't sink the other mode.
const fs = require('node:fs')
const path = require('node:path')

function fail (msg) { console.error(`docx: ${msg}`); process.exit(1) }

const input = (() => {
  try { return JSON.parse(process.env.SKILL_INPUT || '{}') } catch { return {} }
})()

const coop = process.env.KIP_COOP_ROOT ? path.resolve(process.env.KIP_COOP_ROOT) : process.cwd()
const exportsDir = process.env.KIP_EXPORTS_DIR
  ? path.resolve(process.env.KIP_EXPORTS_DIR)
  : path.join(coop, 'exports')

// Legacy runner only: a path — relative *or* absolute — must resolve inside the
// coop. An absolute path that happens to point elsewhere is refused, not read.
function resolveInCoop (rel, label) {
  const abs = path.resolve(coop, rel)
  if (abs !== coop && !abs.startsWith(coop + path.sep)) {
    fail(`${label} "${rel}" resolves outside the coop — use a path inside it.`)
  }
  if (!fs.existsSync(abs)) fail(`${label} not found: ${rel}`)
  return abs
}

// Sandboxed: ask the parent, which owns the vault and the containment check.
async function viaHostcall () {
  const result = await globalThis.kip.hostcall('read_vault_file', { path: String(input.template) })
  if (!result || typeof result.bytes !== 'string') fail(`could not read "${input.template}" from the vault.`)
  return Buffer.from(result.bytes, 'base64')
}

// Legacy `scripts/lib/skills.js` runner: no bridge, so read it directly — with
// the same containment rule the parent applies.
function viaLegacy () {
  return fs.readFileSync(resolveInCoop(input.template, 'template'))
}

async function readTemplateBytes () {
  const hasBridge = globalThis.kip && typeof globalThis.kip.hostcall === 'function'
  return hasBridge ? viaHostcall() : viaLegacy()
}

function relToCoop (p) {
  const r = path.relative(coop, p)
  return r && !r.startsWith('..') ? r.replace(/\\/g, '/') : p
}

function outPath (hint) {
  let base = String(input.filename || hint || `document-${Date.now()}`).trim()
  base = base.replace(/[\\/]/g, '-').replace(/[^\w.\- ]+/g, '').trim()
  if (!base) base = `document-${Date.now()}`
  if (!/\.docx$/i.test(base)) base += '.docx'
  return path.join(exportsDir, base)
}

async function fromTemplate () {
  const tplBytes = await readTemplateBytes()
  const PizZip = require('pizzip')
  const Docxtemplater = require('docxtemplater')
  let doc
  try {
    const zip = new PizZip(tplBytes)
    doc = new Docxtemplater(zip, { paragraphLoop: true, linebreaks: true })
    doc.render(input.data && typeof input.data === 'object' ? input.data : {})
  } catch (err) {
    const errs = err && err.properties && Array.isArray(err.properties.errors)
      ? err.properties.errors.map((e) => (e.properties && e.properties.explanation) || e.message).join('; ')
      : err.message
    fail(`could not fill "${input.template}": ${errs}`)
  }
  const buf = doc.getZip().generate({ type: 'nodebuffer', compression: 'DEFLATE' })
  const base = path.basename(String(input.template), path.extname(String(input.template)))
  const out = outPath(base + '-filled')
  fs.writeFileSync(out, buf)
  console.log(`Filled ${input.template} → ${relToCoop(out)} (${Math.round(buf.length / 1024)} KB).`)
}

async function fromContent () {
  const blocks = Array.isArray(input.content) ? input.content : null
  if (!blocks || !blocks.length) {
    fail('nothing to write — pass "content" (an array of blocks) or "template" + "data".')
  }

  const D = require('docx')
  const HEADINGS = [D.HeadingLevel.HEADING_1, D.HeadingLevel.HEADING_2, D.HeadingLevel.HEADING_3, D.HeadingLevel.HEADING_4]
  const children = []

  if (typeof input.title === 'string' && input.title.trim()) {
    children.push(new D.Paragraph({ text: input.title.trim(), heading: D.HeadingLevel.TITLE }))
  }

  for (const b of blocks) {
    if (!b || typeof b !== 'object') continue
    if (typeof b.heading === 'string') {
      const idx = Math.max(0, Math.min(3, (Number(b.level) || 1) - 1))
      children.push(new D.Paragraph({ text: b.heading, heading: HEADINGS[idx] }))
    } else if (Array.isArray(b.bullets)) {
      const lvl = Number(b.level) > 1 ? Number(b.level) - 1 : 0
      for (const item of b.bullets) children.push(new D.Paragraph({ text: String(item), bullet: { level: lvl } }))
    } else if (b.table && Array.isArray(b.table.rows)) {
      children.push(buildTable(D, b.table))
    } else if (typeof b.text === 'string' || typeof b.paragraph === 'string') {
      const txt = String(b.text != null ? b.text : b.paragraph)
      for (const line of txt.split('\n')) children.push(new D.Paragraph(line))
    }
  }

  if (!children.length) fail('every block was empty or unrecognised.')

  const doc = new D.Document({ sections: [{ children }] })
  const buf = await D.Packer.toBuffer(doc)
  const out = outPath(input.title || 'document')
  fs.writeFileSync(out, buf)
  console.log(`Created ${relToCoop(out)} — ${blocks.length} block(s), ${Math.round(buf.length / 1024)} KB.`)
}

function buildTable (D, t) {
  const rows = []
  if (Array.isArray(t.headers) && t.headers.length) {
    rows.push(new D.TableRow({
      tableHeader: true,
      children: t.headers.map((h) => new D.TableCell({
        children: [new D.Paragraph({ children: [new D.TextRun({ text: String(h), bold: true })] })]
      }))
    }))
  }
  for (const r of t.rows) {
    const cells = Array.isArray(r) ? r : [r]
    rows.push(new D.TableRow({
      children: cells.map((c) => new D.TableCell({
        children: [new D.Paragraph(String(c == null ? '' : c))]
      }))
    }))
  }
  return new D.Table({ rows, width: { size: 100, type: D.WidthType.PERCENTAGE } })
}

;(async () => {
  fs.mkdirSync(exportsDir, { recursive: true })
  if (typeof input.template === 'string' && input.template.trim()) await fromTemplate()
  else await fromContent()
})().catch((err) => fail(err && err.message ? err.message : String(err)))
