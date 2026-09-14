const test = require('node:test')
const assert = require('node:assert/strict')

const { splitBlocks, blockId, hashBlockText, normalizeBlockText } = require('../lib/blocks')

test('splitBlocks: bullets, paragraphs, headings, and document order', () => {
  const body = [
    'Intro paragraph.',
    '',
    '## Sleep hygiene',
    '- Consistent bedtime',
    '- No screens before bed',
    '  a detail line',
    '',
    'A closing paragraph.',
    ''
  ].join('\n')

  const blocks = splitBlocks(body)
  assert.deepEqual(blocks.map((b) => b.text), [
    'Intro paragraph.',
    'Consistent bedtime',
    'No screens before bed\n  a detail line',
    'A closing paragraph.'
  ])
  assert.deepEqual(blocks.map((b) => b.heading), ['', 'Sleep hygiene', 'Sleep hygiene', 'Sleep hygiene'])
  assert.deepEqual(blocks.map((b) => b.index), [0, 1, 2, 3])
})

test('splitBlocks: headings are context, never blocks themselves', () => {
  const blocks = splitBlocks('## Only a heading\n')
  assert.equal(blocks.length, 0)
})

test('splitBlocks: an explicit Logseq id:: is captured, not left in the text', () => {
  const blocks = splitBlocks('- A remembered fact\n  id:: 64f0c2a1-1234-4abc-9def-0123456789ab\n- plain')
  assert.equal(blocks.length, 2)
  assert.equal(blocks[0].explicitId, '64f0c2a1-1234-4abc-9def-0123456789ab')
  assert.equal(blocks[1].explicitId, null)
})

test('blockId: explicit id wins; otherwise path + index', () => {
  assert.equal(blockId({ explicitId: 'abc123', path: 'nest/concepts/x.md', index: 4 }), 'id:abc123')
  assert.equal(blockId({ explicitId: null, path: 'nest/concepts/x.md', index: 4 }), 'nest/concepts/x.md#4')
})

test('hashBlockText: whitespace/format-only changes hash the same', () => {
  assert.equal(hashBlockText('hello   world'), hashBlockText('hello world'))
  assert.equal(hashBlockText('a\nb'), hashBlockText('a b'))
  assert.notEqual(hashBlockText('hello world'), hashBlockText('hello there'))
  assert.equal(normalizeBlockText('  a   b  '), 'a b')
})
