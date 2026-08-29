// Test helper: build a valid npm-style .tgz in memory (gzip + ustar tar,
// every path under a top-level "package/"). Not a test file — the `_`
// prefix and the explicit file list in package.json keep the runner off it.
const zlib = require('node:zlib')

function tarHeader (name, size) {
  const h = Buffer.alloc(512)
  h.write(name.slice(0, 100), 0, 'utf8')
  h.write('0000644\0', 100)
  h.write('0000000\0', 108)
  h.write('0000000\0', 116)
  h.write(size.toString(8).padStart(11, '0') + '\0', 124)
  h.write('00000000000\0', 136)
  h.write('        ', 148) // checksum field starts as spaces
  h.write('0', 156) // typeflag: regular file
  h.write('ustar\0', 257)
  h.write('00', 263)
  let sum = 0
  for (const b of h) sum += b
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148)
  return h
}

/**
 * files: { 'package/package.json': '{...}', 'package/index.js': '…', … }
 * Returns a Buffer (the .tgz bytes).
 */
function makeTgz (files) {
  const parts = []
  for (const [name, content] of Object.entries(files)) {
    const body = Buffer.from(content)
    parts.push(tarHeader(name, body.length))
    const padded = Buffer.alloc(Math.ceil(body.length / 512) * 512)
    body.copy(padded)
    parts.push(padded)
  }
  parts.push(Buffer.alloc(1024)) // two zero blocks = end of archive
  return zlib.gzipSync(Buffer.concat(parts))
}

/** A minimal, valid connector package as a .tgz. */
function connectorTgz ({ name = '@kip-ai/connector', version = '1.0.0', id = 'kip', extra = {} } = {}) {
  const spec = `module.exports = {
    kipConnectorApi: 1,
    id: ${JSON.stringify(id)},
    label: 'Kip (managed)',
    fields: [{ key: 'apiKey', label: 'API key', type: 'password', required: true }],
    envDefaults: { apiKey: 'KIP_API_KEY' },
    isReady: (cfg) => !!cfg.apiKey,
    complete: async () => ({ text: 'ok', raw: {} })
  }`
  return makeTgz({
    'package/package.json': JSON.stringify({ name, version, main: 'index.js', ...extra }),
    'package/index.js': spec
  })
}

module.exports = { makeTgz, connectorTgz }
