const test = require('node:test')
const assert = require('node:assert/strict')

const { parseWhiteboard, whiteboardToOutline } = require('../lib/whiteboard')

// tiny JS -> EDN, good enough for these fixtures (every object key -> :keyword)
function toEdn (v) {
  if (Array.isArray(v)) return `[${v.map(toEdn).join(' ')}]`
  if (v && typeof v === 'object') return `{${Object.entries(v).map(([k, val]) => `:${k} ${toEdn(val)}`).join(' ')}}`
  if (typeof v === 'string') return `"${v}"`
  return String(v)
}

// A shape block as it sits in a real whiteboard .edn.
const shape = (s) => ({ 'block/properties': { 'logseq.tldraw.shape': s } })
const box = (id, label, point) => shape({ type: 'box', id, label, point })
const line = (id, startBinding, endBinding, opts = {}) =>
  shape({ type: 'line', id, label: opts.label || '', decorations: opts.decorations || { end: 'arrow' }, handles: { start: { bindingId: startBinding }, end: { bindingId: endBinding } } })

function board (name, blocks, bindings) {
  return `{:blocks ${toEdn(blocks)} :pages [{:block/type "whiteboard" :block/name "${name}" :block/original-name "${name}" :block/properties {:logseq.tldraw.page {:name "${name}" :bindings ${toEdn(bindings)}}}}]}`
}

test('parseWhiteboard: pulls node labels and directed edges from shapes + bindings', () => {
  const wb = parseWhiteboard(board('My Board',
    [box('root', 'Project', [0, 0]), box('a', 'Goals', [200, 0]), box('b', 'Risks', [200, 100]),
      line('e1', 's1', 'x1'), line('e2', 's2', 'x2')],
    { s1: { fromId: 'e1', toId: 'root' }, x1: { fromId: 'e1', toId: 'a' },
      s2: { fromId: 'e2', toId: 'root' }, x2: { fromId: 'e2', toId: 'b' } }))

  assert.equal(wb.name, 'My Board')
  assert.deepEqual(wb.nodes.map((n) => n.label).sort(), ['Goals', 'Project', 'Risks'])
  const named = (id) => wb.nodes.find((n) => n.id === id).label
  assert.deepEqual(wb.edges.map((e) => `${named(e.from)}->${named(e.to)}`).sort(), ['Project->Goals', 'Project->Risks'])
})

test('whiteboardToOutline: nested bullets follow the arrows; edge labels annotate; cycles are marked', () => {
  const wb = parseWhiteboard(board('Plan',
    [box('root', 'Project', [0, 0]), box('a', 'Goals', [200, 0]), box('b', 'Risks', [200, 100]),
      box('a1', 'Ship v1', [400, 0]), box('lonely', 'Parking lot', [0, 300]),
      line('e1', 's1', 'x1'), line('e2', 's2', 'x2'),
      line('e3', 's3', 'x3', { label: 'blocks' }),
      line('e4', 's4', 'x4')], // a1 -> root : a back-edge (cycle)
    { s1: { fromId: 'e1', toId: 'root' }, x1: { fromId: 'e1', toId: 'a' },
      s2: { fromId: 'e2', toId: 'root' }, x2: { fromId: 'e2', toId: 'b' },
      s3: { fromId: 'e3', toId: 'a' }, x3: { fromId: 'e3', toId: 'a1' },
      s4: { fromId: 'e4', toId: 'a1' }, x4: { fromId: 'e4', toId: 'root' } }))

  const out = whiteboardToOutline(wb)
  assert.match(out, /^- Project\n {2}- Goals\n {4}- Ship v1 _\(blocks\)_\n {6}- ↑ Project\n {2}- Risks/)
  assert.match(out, /_Not connected:_\n- Parking lot/)
})

test('whiteboardToOutline: an undirected connector goes left-to-right by position', () => {
  const wb = parseWhiteboard(board('LR',
    [box('l', 'Left', [0, 0]), box('r', 'Right', [300, 0]),
      line('e', 's', 'x', { decorations: {} })],
    { s: { fromId: 'e', toId: 'r' }, x: { fromId: 'e', toId: 'l' } }))
  assert.equal(whiteboardToOutline(wb), '- Left\n  - Right')
})

test('whiteboardToOutline: empty board', () => {
  assert.match(whiteboardToOutline(parseWhiteboard(board('Blank', [], {}))), /has no shapes yet/)
})
