const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const {
  CONNECTOR_API,
  loadConnectors,
  createRegistry,
  validateSpec,
  resolveConfig,
  missingRequiredField,
  isAllowlisted,
  readConnectorsConfig,
  installConnectorFromTarball,
  removeConnector
} = require('../lib/connectors')
const { makeTgz, connectorTgz } = require('./_tarball')

function tmpVault () {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'connectors-test-'))
  test.after(() => fs.rmSync(d, { recursive: true, force: true }))
  return d
}

/** Write a .tgz buffer to a file inside the vault and return its path. */
function tgzFile (vault, buf, name = 'pkg.tgz') {
  const p = path.join(vault, name)
  fs.writeFileSync(p, buf)
  return p
}

const okSpec = (over = {}) => ({
  kipConnectorApi: CONNECTOR_API,
  id: 'x',
  label: 'X',
  fields: [],
  complete: async () => ({ text: '', raw: {} }),
  ...over
})

test('validateSpec', async (t) => {
  await t.test('accepts a well-formed v1 spec', () => {
    assert.equal(validateSpec(okSpec()), null)
  })
  await t.test('rejects a non-object', () => {
    assert.match(validateSpec(null), /not an object/)
  })
  await t.test('rejects an unknown / missing api major', () => {
    assert.match(validateSpec(okSpec({ kipConnectorApi: 2 })), /unsupported kipConnectorApi/)
    assert.match(validateSpec(okSpec({ kipConnectorApi: undefined })), /unsupported kipConnectorApi/)
  })
  await t.test('rejects missing id / label / complete / fields', () => {
    assert.match(validateSpec(okSpec({ id: undefined })), /missing id/)
    assert.match(validateSpec(okSpec({ label: undefined })), /missing label/)
    assert.match(validateSpec(okSpec({ complete: undefined })), /missing complete/)
    assert.match(validateSpec(okSpec({ fields: undefined })), /missing fields/)
  })
})

test('createRegistry: skips invalid specs and id collisions with a warning, keeps the rest', () => {
  const warnings = []
  const reg = createRegistry(
    [okSpec({ id: 'a' }), okSpec({ id: 'a', label: 'dup' }), okSpec({ id: 'b', kipConnectorApi: 9 }), okSpec({ id: 'c' })],
    { logger: { warn: (m) => warnings.push(m) } }
  )
  assert.deepEqual(reg.ids(), ['a', 'c'])
  assert.equal(reg.get('a').label, 'X', 'first registration wins the id')
  assert.equal(reg.get('b'), null)
  assert.equal(reg.has('c'), true)
  assert.equal(warnings.length, 2)
})

test('resolveConfig: file over env over field default', () => {
  const spec = {
    fields: [
      { key: 'apiKey' },
      { key: 'model', default: 'default-model' },
      { key: 'baseUrl', default: 'https://default' }
    ],
    envDefaults: { apiKey: 'X_KEY', model: 'X_MODEL', baseUrl: 'X_URL' }
  }
  const env = { X_KEY: 'env-key', X_MODEL: 'env-model' }
  const resolved = resolveConfig(spec, { model: 'file-model' }, env)
  assert.equal(resolved.apiKey, 'env-key', 'no file value -> env')
  assert.equal(resolved.model, 'file-model', 'file wins over env and default')
  assert.equal(resolved.baseUrl, 'https://default', 'no file/env -> field default')
})

test('missingRequiredField: first blank required field, else null', () => {
  const spec = { fields: [{ key: 'a', required: true }, { key: 'b', label: 'B', required: true }] }
  assert.equal(missingRequiredField(spec, { a: 'set', b: 'set' }), null)
  assert.equal(missingRequiredField(spec, { a: 'set' }).key, 'b')
  assert.equal(missingRequiredField(spec, {}).key, 'a')
})

const BUILTIN_IDS = ['anthropic', 'deepseek', 'kip', 'local', 'openai', 'other']

test('loadConnectors: returns the built-ins (incl. the managed kip connector), all valid v1 specs', () => {
  const reg = loadConnectors()
  assert.deepEqual(reg.ids().sort(), BUILTIN_IDS)
  for (const spec of reg.list()) {
    assert.equal(validateSpec(spec), null, `${spec.id} is a valid spec`)
    assert.equal(typeof spec.isReady, 'function')
    assert.equal(spec.kipConnectorApi, CONNECTOR_API)
  }
})

test('loadConnectors: built-in readiness matches its resolved config', () => {
  const reg = loadConnectors()
  assert.equal(reg.get('anthropic').isReady({}), true, 'anthropic is always ready (SDK cred chain)')
  assert.equal(reg.get('openai').isReady({ apiKey: 'k' }), false, 'openai needs a model too')
  assert.equal(reg.get('openai').isReady({ apiKey: 'k', model: 'm' }), true)
  assert.equal(reg.get('other').isReady({ model: 'm' }), false, 'other needs a base URL')
  assert.equal(reg.get('other').isReady({ baseUrl: 'u', model: 'm' }), true)
  assert.equal(reg.get('kip').isReady({}), false, 'the managed connector needs a kip_ key')
  assert.equal(reg.get('kip').isReady({ apiKey: 'kip_x' }), true)
})

// ---------------------------------------------------------------------------
// Graph-local connector install / discovery / remove (kip-app#56)
// ---------------------------------------------------------------------------

const quiet = { logger: { warn () {} } }

test('isAllowlisted: only @kip-ai/* passes', () => {
  assert.equal(isAllowlisted('@kip-ai/connector'), true)
  assert.equal(isAllowlisted('@kip-ai/experimental'), true)
  assert.equal(isAllowlisted('@evil/kip-ai'), false)
  assert.equal(isAllowlisted('kip-connector'), false)
  assert.equal(isAllowlisted(''), false)
  assert.equal(isAllowlisted(undefined), false)
})

test('installConnectorFromTarball: refuses a non-allowlisted package', async () => {
  const v = tmpVault()
  const tgz = tgzFile(v, connectorTgz({ name: 'totally-legit-connector' }))
  await assert.rejects(() => installConnectorFromTarball(tgz, v, quiet), /not an allowed connector/)
  assert.deepEqual(readConnectorsConfig(v), [], 'nothing recorded')
})

test('installConnectorFromTarball: refuses a tarball that is not a valid ProviderSpec', async () => {
  const v = tmpVault()
  const bad = makeTgz({
    'package/package.json': JSON.stringify({ name: '@kip-ai/broken', version: '1.0.0', main: 'index.js' }),
    'package/index.js': 'module.exports = { id: "x" }' // no kipConnectorApi, no complete
  })
  await assert.rejects(() => installConnectorFromTarball(tgzFile(v, bad), v, quiet), /isn't a valid connector/)
})

test('installConnectorFromTarball: refuses an id that collides with a built-in', async () => {
  const v = tmpVault()
  const tgz = tgzFile(v, connectorTgz({ id: 'openai' }))
  await assert.rejects(() => installConnectorFromTarball(tgz, v, quiet), /built-in provider/)
})

test('connector lifecycle: install -> load -> remove', async () => {
  const v = tmpVault()
  const res = await installConnectorFromTarball(tgzFile(v, connectorTgz()), v, quiet)
  assert.deepEqual(res, { ok: true, id: 'kip-exp', name: '@kip-ai/experimental', version: '1.0.0' })

  // recorded in connectors.json + on disk
  assert.deepEqual(readConnectorsConfig(v), [
    { id: 'kip-exp', name: '@kip-ai/experimental', version: '1.0.0', dir: 'kip-ai__experimental' }
  ])
  assert.ok(fs.existsSync(path.join(v, '.henhouse', 'connectors', 'kip-ai__experimental', 'index.js')))

  // shows up in the registry, usable
  const reg = loadConnectors(v, quiet)
  assert.ok(reg.has('kip-exp'))
  assert.equal(reg.get('kip-exp').label, 'Kip experimental')
  assert.equal(reg.get('kip-exp').isReady({ apiKey: 'kip_x' }), true)
  assert.equal(reg.get('kip-exp').isReady({}), false)

  // second install of the same id is refused
  await assert.rejects(() => installConnectorFromTarball(tgzFile(v, connectorTgz()), v, quiet), /already installed/)

  // remove: gone from disk, config, and the registry
  assert.deepEqual(removeConnector('kip-exp', v), { ok: true, id: 'kip-exp' })
  assert.deepEqual(readConnectorsConfig(v), [])
  assert.equal(fs.existsSync(path.join(v, '.henhouse', 'connectors', 'kip-ai__experimental')), false)
  assert.equal(loadConnectors(v, quiet).has('kip-exp'), false)

  assert.deepEqual(removeConnector('kip-exp', v), { ok: false, error: 'No installed connector "kip-exp".' })
})

test('installConnectorFromTarball: refuses an id that collides with the built-in kip connector', async () => {
  const v = tmpVault()
  await assert.rejects(
    () => installConnectorFromTarball(tgzFile(v, connectorTgz({ id: 'kip' })), v, quiet),
    /built-in provider/
  )
})

test('loadConnectors: a graph-local connector listed but missing from disk is skipped, not fatal', () => {
  const v = tmpVault()
  fs.mkdirSync(path.join(v, '.henhouse'), { recursive: true })
  fs.writeFileSync(
    path.join(v, '.henhouse', 'connectors.json'),
    JSON.stringify([{ id: 'ghost', name: '@kip-ai/ghost', version: '1.0.0', dir: 'kip-ai__ghost' }])
  )
  const warnings = []
  const reg = loadConnectors(v, { logger: { warn: (m) => warnings.push(m) } })
  assert.deepEqual(reg.ids().sort(), BUILTIN_IDS)
  assert.match(warnings.join('\n'), /ghost/)
})

test('installConnectorFromTarball: needs an open graph', async () => {
  await assert.rejects(() => installConnectorFromTarball('/tmp/x.tgz', undefined, quiet), /Open a folder first/)
})
