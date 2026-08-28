// Turns a Logseq/Kip whiteboard (an EDN file under coop/whiteboards/) into a
// plain-text outline. A whiteboard is `{:blocks (...) :pages ({... :logseq.tldraw.page
// {:bindings {...} ...}})}`; each block's :logseq.tldraw.shape is a box, a
// connector "line", or an embed. `:bindings` maps a bindingId to
// {fromId=<line id>, toId=<box id>, handleId "start"|"end"} — the connections.
//
// A mindmap (boxes joined by arrow lines, one or more roots) becomes a nested
// bullet list following the arrows. Anything not reachable from a root is
// listed flat at the end. Cycles are broken with an "↑ label" marker.
//
// Deterministic — no LLM. scripts/lib/hatch.js writes the result straight to
// nest/sources/<board>.md when "Hatch sources" sees a new-or-changed .edn.
const { parseEDNString } = require('edn-data')

const EDN_OPTS = { mapAs: 'object', keywordAs: 'string', listAs: 'array' }
const MAX_DEPTH = 40

/**
 * @returns {{name: string,
 *            nodes: Array<{id, label, x, y}>,
 *            edges: Array<{from, to, label}>}}
 */
function parseWhiteboard (ednText) {
  const doc = parseEDNString(ednText, EDN_OPTS)
  const blocks = Array.isArray(doc.blocks) ? doc.blocks : []
  const page = (Array.isArray(doc.pages) ? doc.pages[0] : null) || {}
  const pageProps = (page['block/properties'] || {})['logseq.tldraw.page'] || {}
  const name = pageProps.name || page['block/original-name'] || page['block/name'] || 'whiteboard'
  const bindings = pageProps.bindings || {}

  const shapes = blocks
    .map((b) => (b['block/properties'] || {})['logseq.tldraw.shape'])
    .filter(Boolean)

  const shapeById = new Map(shapes.map((s) => [s.id, s]))
  const nodeTypes = new Set(['box', 'ellipse', 'polygon', 'html', 'logseq-portal'])

  const nodes = []
  for (const s of shapes) {
    if (!nodeTypes.has(s.type)) continue
    const label = nodeLabel(s)
    const [x = 0, y = 0] = Array.isArray(s.point) ? s.point : []
    nodes.push({ id: s.id, label, x, y })
  }

  // A connector line binds its "start" and "end" handles to boxes via bindings.
  const boxForBinding = (bindingId) => {
    const bnd = bindingId && bindings[bindingId]
    return bnd && shapeById.has(bnd.toId) && nodeTypes.has(shapeById.get(bnd.toId).type) ? bnd.toId : null
  }

  const edges = []
  for (const s of shapes) {
    if (s.type !== 'line' || !s.handles) continue
    const a = boxForBinding(s.handles.start && s.handles.start.bindingId)
    const b = boxForBinding(s.handles.end && s.handles.end.bindingId)
    if (!a || !b || a === b) continue

    const dec = s.decorations || {}
    let from = a
    let to = b
    if (dec.end === 'arrow' && dec.start !== 'arrow') { from = a; to = b } else if (dec.start === 'arrow' && dec.end !== 'arrow') { from = b; to = a } else {
      // undirected: left-to-right, then top-to-bottom
      const na = shapeById.get(a)
      const nb = shapeById.get(b)
      const pa = na && na.point ? na.point : [0, 0]
      const pb = nb && nb.point ? nb.point : [0, 0]
      if (pb[0] < pa[0] || (pb[0] === pa[0] && pb[1] < pa[1])) { from = b; to = a }
    }
    edges.push({ from, to, label: (s.label || '').trim() })
  }

  return { name, nodes, edges }
}

function nodeLabel (shape) {
  if (shape.label && shape.label.trim()) return shape.label.trim()
  if (shape.type === 'logseq-portal' && shape.pageId) {
    return shape.blockType === 'P' ? `[[${shape.pageId}]]` : `((${shape.pageId}))`
  }
  return '(untitled)'
}

/** Nested bullet outline following the arrows; unreachable nodes listed flat. */
function whiteboardToOutline ({ name, nodes, edges }) {
  if (!nodes.length) return `_Whiteboard **${name}** has no shapes yet._`

  const byId = new Map(nodes.map((n) => [n.id, n]))
  const children = new Map(nodes.map((n) => [n.id, []]))
  const indeg = new Map(nodes.map((n) => [n.id, 0]))
  for (const e of edges) {
    if (!children.has(e.from) || !byId.has(e.to)) continue
    children.get(e.from).push(e)
    indeg.set(e.to, indeg.get(e.to) + 1)
  }
  for (const [, list] of children) {
    list.sort((x, y) => {
      const a = byId.get(x.to)
      const b = byId.get(y.to)
      return a.y - b.y || a.x - b.x
    })
  }

  const lines = []
  const visited = new Set()

  const walk = (id, depth) => {
    const node = byId.get(id)
    const indent = '  '.repeat(depth)
    if (visited.has(id)) {
      lines.push(`${indent}- ↑ ${node.label}`)
      return
    }
    visited.add(id)
    lines.push(`${indent}- ${node.label}`)
    if (depth >= MAX_DEPTH) return
    for (const e of children.get(id)) {
      const via = e.label ? ` _(${e.label})_` : ''
      if (visited.has(e.to)) {
        lines.push(`${'  '.repeat(depth + 1)}- ↑ ${byId.get(e.to).label}${via}`)
        continue
      }
      const childLineIndex = lines.length // walk() pushes the child's bullet first
      walk(e.to, depth + 1)
      if (via && lines[childLineIndex] !== undefined) lines[childLineIndex] += via
    }
  }

  const hasOut = (id) => children.get(id).length > 0
  const topFirst = (a, b) => a.y - b.y || a.x - b.x

  // Clean roots first: no inbound edge, at least one outbound.
  const roots = nodes.filter((n) => indeg.get(n.id) === 0 && hasOut(n.id)).sort(topFirst)
  let wroteTree = false
  for (const r of roots) { walk(r.id, 0); wroteTree = true }

  // Then any component the roots didn't reach (a cycle with no clean entry,
  // or a disconnected sub-graph) — enter it at its topmost node with edges.
  for (const n of [...nodes].sort(topFirst)) {
    if (!visited.has(n.id) && hasOut(n.id)) { walk(n.id, 0); wroteTree = true }
  }

  const loose = nodes.filter((n) => !visited.has(n.id)).sort(topFirst)
  if (loose.length) {
    if (lines.length) lines.push('')
    if (wroteTree) lines.push('_Not connected:_')
    for (const n of loose) lines.push(`- ${n.label}`)
  }

  return lines.join('\n')
}

module.exports = { parseWhiteboard, whiteboardToOutline }
