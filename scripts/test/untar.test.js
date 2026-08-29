const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const zlib = require('node:zlib')

const { extractNpmTarball } = require('../lib/untar')
const { makeTgz } = require('./_tarball')

function tmpDir () {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'untar-test-'))
  test.after(() => fs.rmSync(d, { recursive: true, force: true }))
  return d
}

test('extractNpmTarball: unpacks files, stripping the leading package/ dir', () => {
  const dir = tmpDir()
  const written = extractNpmTarball(makeTgz({
    'package/package.json': '{"name":"x"}',
    'package/lib/a.js': 'module.exports = 1'
  }), dir)
  assert.deepEqual(written.sort(), ['lib/a.js', 'package.json'])
  assert.equal(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'), '{"name":"x"}')
  assert.equal(fs.readFileSync(path.join(dir, 'lib', 'a.js'), 'utf8'), 'module.exports = 1')
})

test('extractNpmTarball: rejects a non-gzip buffer', () => {
  assert.throws(() => extractNpmTarball(Buffer.from('not a gzip'), tmpDir()), /gzipped tarball/)
})

test('extractNpmTarball: rejects path traversal', () => {
  const evil = makeTgz({ 'package/../../escape.js': 'pwned' })
  assert.throws(() => extractNpmTarball(evil, tmpDir()), /unsafe path/)
})

test('extractNpmTarball: rejects an absolute path', () => {
  const evil = makeTgz({ 'package//etc/passwd': 'x' })
  assert.throws(() => extractNpmTarball(evil, tmpDir()), /unsafe path/)
})

test('extractNpmTarball: rejects an archive with no files', () => {
  assert.throws(() => extractNpmTarball(zlib.gzipSync(Buffer.alloc(1024)), tmpDir()), /no files/)
})

test('extractNpmTarball: enforces the per-file size cap', () => {
  // one 17 MB entry — over MAX_FILE_BYTES (16 MB)
  const big = makeTgz({ 'package/big.bin': 'a'.repeat(17 * 1024 * 1024) })
  assert.throws(() => extractNpmTarball(big, tmpDir()), /too large/)
})
