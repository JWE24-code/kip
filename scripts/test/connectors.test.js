const test = require('node:test')
const assert = require('node:assert/strict')

const {
  CONNECTOR_API,
  loadConnectors,
  createRegistry,
  validateSpec,
  resolveConfig,
  missingRequiredField
} = require('../lib/connectors')

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

test('loadConnectors: returns the five built-ins, all valid v1 specs', () => {
  const reg = loadConnectors()
  assert.deepEqual(reg.ids().sort(), ['anthropic', 'deepseek', 'local', 'openai', 'other'])
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
})
