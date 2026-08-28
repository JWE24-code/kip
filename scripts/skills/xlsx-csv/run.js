// xlsx-csv skill — reads SKILL_INPUT {file, operation?, sheet?, maxRows?},
// prints a markdown summary of the spreadsheet to stdout.
const fs = require('node:fs')
const path = require('node:path')

function fail (msg) {
  console.error(msg)
  process.exit(1)
}

const input = (() => {
  try { return JSON.parse(process.env.SKILL_INPUT || '{}') } catch { return {} }
})()

if (typeof input.file !== 'string' || !input.file.trim()) {
  fail('xlsx-csv: "file" is required (a path to a .xlsx/.xls/.csv, relative to the coop root).')
}

const coop = process.env.KIP_COOP_ROOT ? path.resolve(process.env.KIP_COOP_ROOT) : null
const abs = path.resolve(coop || process.cwd(), input.file)

// Containment: a relative path must stay inside the coop. An absolute path is
// allowed (the user may want a file elsewhere) but a relative "../" escape is not.
if (coop && !path.isAbsolute(input.file) && !(abs === coop || abs.startsWith(coop + path.sep))) {
  fail(`xlsx-csv: "${input.file}" resolves outside the coop — use a path inside it, or an absolute path.`)
}
if (!fs.existsSync(abs)) fail(`xlsx-csv: no such file: ${input.file}`)

let XLSX
try {
  XLSX = require('xlsx')
} catch {
  fail('xlsx-csv: the "xlsx" package is not installed. Run `npm install` in scripts/ (or the app is missing static/scripts/node_modules/xlsx).')
}

let wb
try {
  wb = XLSX.readFile(abs, { cellDates: true })
} catch (err) {
  fail(`xlsx-csv: could not read ${input.file}: ${err.message}`)
}

const sheetName = input.sheet && wb.SheetNames.includes(input.sheet) ? input.sheet : wb.SheetNames[0]
if (input.sheet && !wb.SheetNames.includes(input.sheet)) {
  fail(`xlsx-csv: no sheet "${input.sheet}". Sheets: ${wb.SheetNames.join(', ')}`)
}
const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { defval: null })
const columns = rows.length ? Object.keys(rows[0]) : []

const op = input.operation === 'head' ? 'head' : 'summarize'
const out = []
out.push(`**${path.basename(abs)}** — sheet \`${sheetName}\`${wb.SheetNames.length > 1 ? ` (of ${wb.SheetNames.length}: ${wb.SheetNames.join(', ')})` : ''}`)
out.push(`${rows.length} row${rows.length === 1 ? '' : 's'}, ${columns.length} column${columns.length === 1 ? '' : 's'}.`)

function cellText (v) {
  if (v === null || v === undefined) return ''
  if (v instanceof Date) return v.toISOString().slice(0, 10)
  return String(v)
}

function mdTable (data, cols) {
  if (!data.length) return '_(no rows)_'
  const lines = ['| ' + cols.join(' | ') + ' |', '| ' + cols.map(() => '---').join(' | ') + ' |']
  for (const r of data) lines.push('| ' + cols.map((c) => cellText(r[c]).replace(/\|/g, '\\|')).join(' | ') + ' |')
  return lines.join('\n')
}

if (op === 'summarize' && rows.length) {
  out.push('', '| column | type | notes |', '| --- | --- | --- |')
  for (const c of columns) {
    const vals = rows.map((r) => r[c]).filter((v) => v !== null && v !== undefined && v !== '')
    const nums = vals.map(Number).filter((n) => Number.isFinite(n))
    let type = 'text'
    let notes = `${vals.length}/${rows.length} filled`
    if (vals.length && nums.length === vals.length) {
      type = 'number'
      const sum = nums.reduce((a, b) => a + b, 0)
      notes += ` · min ${Math.min(...nums)} · max ${Math.max(...nums)} · sum ${round(sum)} · mean ${round(sum / nums.length)}`
    } else if (vals.length && vals.every((v) => v instanceof Date)) {
      type = 'date'
    }
    out.push(`| ${c} | ${type} | ${notes} |`)
  }
  out.push('', 'First rows:', '', mdTable(rows.slice(0, 5), columns))
} else {
  const n = Number.isFinite(Number(input.maxRows)) && Number(input.maxRows) > 0 ? Math.floor(Number(input.maxRows)) : 20
  out.push('', mdTable(rows.slice(0, n), columns))
  if (rows.length > n) out.push('', `_… ${rows.length - n} more row(s)._`)
}

function round (n) { return Math.round(n * 1000) / 1000 }

console.log(out.join('\n'))
