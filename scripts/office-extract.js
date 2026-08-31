#!/usr/bin/env node
// Convert one Office / PDF file to Markdown (scripts/lib/office.js) and write
// it as a Hatch source. The Kip app shells out to this when you drop a .docx /
// .xlsx / .pptx / .pdf onto the Peck or Hatch view; it also runs standalone.
//
//   node scripts/office-extract.js <input> [<output.md>] [--json] [--stdout]
//
//   <input>       a .docx / .xlsx / .xls / .csv / .pptx / .pdf
//   <output.md>   where to write (default: <input dir>/<input name>.md)
//   --stdout      print the Markdown instead of writing a file
//   --json        print one line of JSON: { ok, output, kind, chars, warnings }
//                 (or { ok:false, error, ext } on failure) and exit 0/1
//
// The output gets front-matter recording where it came from, so a hatched page
// can be traced back to the original document.

const fs = require('node:fs')
const path = require('node:path')
const { extractToMarkdown, toHatchSource, markdownNameFor, UnsupportedFormatError } = require('./lib/office')

const argv = process.argv.slice(2)
const asJson = argv.includes('--json')
const toStdout = argv.includes('--stdout')
const positionals = argv.filter((a) => !a.startsWith('--'))

function done (obj, human) {
  if (asJson) {
    // --json is a machine contract: the result is always on stdout, `ok` says
    // whether it worked, exit stays 0 so a caller reads the JSON not the code.
    console.log(JSON.stringify(obj))
  } else {
    if (human) console.log(human)
    if (!obj.ok) console.error(obj.error)
    process.exitCode = obj.ok ? 0 : 1
  }
}

async function main () {
  const input = positionals[0]
  if (!input) {
    done({ ok: false, error: 'usage: office-extract.js <input> [<output.md>] [--json] [--stdout]' })
    return
  }
  const absIn = path.resolve(input)
  if (!fs.existsSync(absIn)) {
    done({ ok: false, error: `no such file: ${input}` })
    return
  }

  let result
  try {
    result = await extractToMarkdown(absIn)
  } catch (err) {
    done({
      ok: false,
      error: (err && err.message) || String(err),
      ext: err instanceof UnsupportedFormatError ? err.ext : undefined
    })
    return
  }

  const srcName = path.basename(absIn)
  const body = toHatchSource(srcName, result)

  if (toStdout) {
    process.stdout.write(body)
    done({ ok: true, output: null, kind: result.kind, chars: result.markdown.length, warnings: result.warnings })
    return
  }

  const absOut = path.resolve(positionals[1] || path.join(path.dirname(absIn), markdownNameFor(srcName)))
  fs.mkdirSync(path.dirname(absOut), { recursive: true })
  fs.writeFileSync(absOut, body)
  done(
    { ok: true, output: absOut, kind: result.kind, chars: result.markdown.length, warnings: result.warnings },
    `Wrote ${absOut} (${result.kind}, ${result.markdown.length} chars)` +
      (result.warnings.length ? `\n  ${result.warnings.join('\n  ')}` : ''))
}

main().catch((err) => {
  done({ ok: false, error: (err && err.stack) || String(err) })
})
