const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { preferenceSignalsEnabled, preferenceSignalsTarget } = require('../lib/preference-signals')

const EMPTY_VAULT = fs.mkdtempSync(path.join(os.tmpdir(), 'pref-signals-test-'))
test.after(() => fs.rmSync(EMPTY_VAULT, { recursive: true, force: true }))

/** Set env vars for the duration of fn, restoring after. */
async function withEnv (vars, fn) {
  const original = {}
  for (const k of Object.keys(vars)) {
    original[k] = process.env[k]
    if (vars[k] === undefined) delete process.env[k]
    else process.env[k] = vars[k]
  }
  try { return await fn() } finally {
    for (const [k, v] of Object.entries(original)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

test('preferenceSignalsEnabled: true only for the kip provider', async () => {
  await withEnv({ PROVIDER: 'kip', KIP_API_KEY: 'kip_x' }, () => {
    assert.equal(preferenceSignalsEnabled(EMPTY_VAULT), true)
  })
  await withEnv({ PROVIDER: 'anthropic' }, () => {
    assert.equal(preferenceSignalsEnabled(EMPTY_VAULT), false)
  })
  await withEnv({ PROVIDER: 'deepseek', DEEPSEEK_API_KEY: 'sk-x' }, () => {
    assert.equal(preferenceSignalsEnabled(EMPTY_VAULT), false)
  })
})

test('preferenceSignalsEnabled: kip with no key still counts as the active provider', async () => {
  // the gate is "is kip the provider", not "is kip fully configured" — a
  // key-less kip is still the surface to show (it just can't post yet).
  await withEnv({ PROVIDER: 'kip', KIP_API_KEY: undefined }, () => {
    assert.equal(preferenceSignalsEnabled(EMPTY_VAULT), true)
  })
})

test('preferenceSignalsEnabled: never throws on a broken PROVIDER', async () => {
  await withEnv({ PROVIDER: 'not-a-provider' }, () => {
    assert.equal(preferenceSignalsEnabled(EMPTY_VAULT), false)
  })
})

test('preferenceSignalsTarget: resolved baseUrl + apiKey for kip, else null', async () => {
  await withEnv({ PROVIDER: 'kip', KIP_API_KEY: 'kip_live', KIP_BASE_URL: 'http://lan.test:3000/' }, () => {
    assert.deepEqual(preferenceSignalsTarget(EMPTY_VAULT), {
      baseUrl: 'http://lan.test:3000', // trailing slash trimmed
      apiKey: 'kip_live'
    })
  })
  await withEnv({ PROVIDER: 'kip', KIP_API_KEY: undefined }, () => {
    assert.equal(preferenceSignalsTarget(EMPTY_VAULT), null, 'no key -> null')
  })
  await withEnv({ PROVIDER: 'anthropic' }, () => {
    assert.equal(preferenceSignalsTarget(EMPTY_VAULT), null, 'wrong provider -> null')
  })
})

test('preferenceSignalsTarget: falls back to the hosted base URL', async () => {
  await withEnv({ PROVIDER: 'kip', KIP_API_KEY: 'kip_x', KIP_BASE_URL: undefined }, () => {
    assert.equal(preferenceSignalsTarget(EMPTY_VAULT).baseUrl, 'https://api.kip-ai.be')
  })
})
