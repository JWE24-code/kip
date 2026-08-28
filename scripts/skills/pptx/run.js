// pptx skill — writes a .pptx into <coop>/exports/ and prints its path.
//
//   outline mode  (default)        — build with pptxgenjs from `slides`
//   theme mode    (input.theme)    — outline mode + a JSON brand theme
//   template mode (input.template) — clone a .pptx's first slide per slide,
//                                    best-effort fill of title/body placeholders
//                                    (pptx-automizer)
//
// Deps (pure JS): pptxgenjs, pptx-automizer. Required lazily.
const fs = require('node:fs')
const path = require('node:path')

function fail (msg) { console.error(`pptx: ${msg}`); process.exit(1) }

const input = (() => {
  try { return JSON.parse(process.env.SKILL_INPUT || '{}') } catch { return {} }
})()

const coop = process.env.KIP_COOP_ROOT ? path.resolve(process.env.KIP_COOP_ROOT) : process.cwd()
const exportsDir = process.env.KIP_EXPORTS_DIR
  ? path.resolve(process.env.KIP_EXPORTS_DIR)
  : path.join(coop, 'exports')

function resolveInCoop (rel, label) {
  const abs = path.resolve(coop, rel)
  if (!path.isAbsolute(rel) && !(abs === coop || abs.startsWith(coop + path.sep))) {
    fail(`${label} "${rel}" resolves outside the coop — use a path inside it.`)
  }
  if (!fs.existsSync(abs)) fail(`${label} not found: ${rel}`)
  return abs
}

function relToCoop (p) {
  const r = path.relative(coop, p)
  return r && !r.startsWith('..') ? r.replace(/\\/g, '/') : p
}

function outName (hint) {
  let base = String(input.filename || hint || `deck-${Date.now()}`).trim()
  base = base.replace(/[\\/]/g, '-').replace(/[^\w.\- ]+/g, '').trim()
  if (!base) base = `deck-${Date.now()}`
  if (!/\.pptx$/i.test(base)) base += '.pptx'
  return base
}

const slides = Array.isArray(input.slides) ? input.slides.filter((s) => s && typeof s === 'object') : []
if (!slides.length) fail('"slides" is required — an array of slide specs.')

// --------------------------------------------------------------------------
// template mode — pptx-automizer
// --------------------------------------------------------------------------
async function fromTemplate () {
  const tpl = resolveInCoop(input.template, 'template')
  const { Automizer, ModifyTextHelper } = require('pptx-automizer')
  const dir = path.dirname(tpl)
  const name = path.basename(tpl)

  const automizer = new Automizer({
    templateDir: dir,
    outputDir: exportsDir,
    removeExistingSlides: true,
    autoImportSlideMasters: true,
    cleanup: true
  })

  let pres
  let textShapes = []
  try {
    pres = automizer.loadRoot(name).load(name, 'tpl')
    const info = await automizer.getInfo()
    const tplSlides = info.slidesByTemplate('tpl')
    const first = tplSlides && tplSlides[0]
    if (!first) fail(`template "${input.template}" has no slides to clone.`)
    textShapes = (first.elements || [])
      .filter((e) => e.hasTextBody && e.position)
      .sort((a, b) => (a.position.y || 0) - (b.position.y || 0))
      .map((e) => e.name)
  } catch (err) {
    fail(`could not read template "${input.template}": ${err.message}`)
  }

  const titleShape = textShapes[0] || null
  const bodyShape = textShapes[1] || null
  let filled = 0

  for (const spec of slides) {
    const heading = String(spec.title || spec.section || '')
    const bullets = Array.isArray(spec.bullets) ? spec.bullets.map((b) => String(b)) : null
    const body = bullets ? null : String(spec.text || '')

    pres = pres.addSlide('tpl', 1, (slide) => {
      if (titleShape && heading) {
        try { slide.modifyElement(titleShape, [ModifyTextHelper.setText(heading)]); filled++ } catch { /* leave placeholder */ }
      }
      const target = bodyShape || (heading ? null : titleShape)
      if (target && bullets && bullets.length) {
        try { slide.modifyElement(target, [ModifyTextHelper.setBulletList(bullets)]) } catch { /* ignore */ }
      } else if (target && body) {
        try { slide.modifyElement(target, [ModifyTextHelper.setText(body)]) } catch { /* ignore */ }
      }
    })
  }

  const out = outName(path.basename(tpl, path.extname(tpl)) + '-deck')
  await pres.write(out)
  const note = textShapes.length
    ? `filled ${filled}/${slides.length} title placeholders`
    : 'the template had no text placeholders, so only its branding was applied'
  console.log(`Created ${relToCoop(path.join(exportsDir, out))} — ${slides.length} slide(s) cloned from ${input.template}; ${note}.`)
}

// --------------------------------------------------------------------------
// outline / theme mode — pptxgenjs
// --------------------------------------------------------------------------
function hex (v, fallback) {
  if (typeof v !== 'string') return fallback
  const h = v.replace(/^#/, '').trim()
  return /^[0-9a-fA-F]{6}$/.test(h) ? h.toUpperCase() : fallback
}

async function fromOutline () {
  const PptxGenJS = require('pptxgenjs')
  const pptx = new PptxGenJS()
  pptx.layout = 'LAYOUT_WIDE' // 13.33 x 7.5 in

  let theme = {}
  if (typeof input.theme === 'string' && input.theme.trim()) {
    const tp = resolveInCoop(input.theme, 'theme')
    try { theme = JSON.parse(fs.readFileSync(tp, 'utf8')) || {} } catch (err) { fail(`theme "${input.theme}" is not valid JSON: ${err.message}`) }
  }
  const primary = hex(theme.primary, '1F4E79')
  const accent = hex(theme.accent, 'ED7D31')
  const textColor = hex(theme.text, '333333')
  const bg = hex(theme.background, 'FFFFFF')
  const font = typeof theme.font === 'string' && theme.font.trim() ? theme.font.trim() : 'Calibri'
  const footer = typeof theme.footer === 'string' ? theme.footer.trim() : ''
  const logo = typeof theme.logo === 'string' && theme.logo.trim() ? resolveInCoop(theme.logo, 'theme logo') : null

  const masterObjects = []
  if (footer) masterObjects.push({ text: { text: footer, options: { x: 0.4, y: 7.02, w: 10, h: 0.35, fontSize: 9, color: textColor, fontFace: font } } })
  if (logo) masterObjects.push({ image: { path: logo, x: 11.7, y: 6.85, w: 1.2, h: 0.5 } })
  pptx.defineSlideMaster({ title: 'KIP', background: { color: bg }, objects: masterObjects })

  if (typeof input.title === 'string' && input.title.trim()) {
    const s = pptx.addSlide({ masterName: 'KIP' })
    s.addText(input.title.trim(), { x: 0.7, y: 2.7, w: 12, h: 1.6, fontSize: 40, bold: true, color: primary, fontFace: font })
    if (typeof input.subtitle === 'string' && input.subtitle.trim()) {
      s.addText(input.subtitle.trim(), { x: 0.7, y: 4.2, w: 12, h: 0.8, fontSize: 18, color: textColor, fontFace: font })
    }
  }

  for (const spec of slides) {
    const s = pptx.addSlide({ masterName: 'KIP' })
    if (typeof spec.section === 'string' && spec.section.trim()) {
      s.background = { color: accent }
      s.addText(spec.section.trim(), { x: 0.8, y: 3.0, w: 11.7, h: 1.5, fontSize: 34, bold: true, color: 'FFFFFF', fontFace: font })
      continue
    }
    const heading = typeof spec.title === 'string' ? spec.title.trim() : ''
    if (heading) s.addText(heading, { x: 0.6, y: 0.4, w: 12.1, h: 1.0, fontSize: 28, bold: true, color: primary, fontFace: font })
    const bodyY = heading ? 1.7 : 0.6
    const bodyH = 7.5 - bodyY - 0.5

    if (Array.isArray(spec.bullets) && spec.bullets.length) {
      s.addText(
        spec.bullets.map((b) => ({ text: String(b), options: { bullet: true } })),
        { x: 0.9, y: bodyY, w: 11.5, h: bodyH, fontSize: 18, color: textColor, fontFace: font, valign: 'top', lineSpacingMultiple: 1.2 }
      )
    } else if (typeof spec.text === 'string' && spec.text.trim()) {
      s.addText(spec.text.trim(), { x: 0.9, y: bodyY, w: 11.5, h: bodyH, fontSize: 18, color: textColor, fontFace: font, valign: 'top' })
    } else if (typeof spec.image === 'string' && spec.image.trim()) {
      const img = resolveInCoop(spec.image, 'slide image')
      s.addImage({ path: img, x: 0.9, y: bodyY, w: 11.5, h: bodyH, sizing: { type: 'contain', w: 11.5, h: bodyH } })
    }
  }

  const out = path.join(exportsDir, outName(input.title || 'deck'))
  await pptx.writeFile({ fileName: out })
  const styled = input.theme ? ` (themed: ${input.theme})` : ''
  console.log(`Created ${relToCoop(out)} — ${slides.length} slide(s)${input.title ? ' + title' : ''}${styled}.`)
}

;(async () => {
  fs.mkdirSync(exportsDir, { recursive: true })
  if (typeof input.template === 'string' && input.template.trim()) await fromTemplate()
  else await fromOutline()
})().catch((err) => fail(err && err.message ? err.message : String(err)))
