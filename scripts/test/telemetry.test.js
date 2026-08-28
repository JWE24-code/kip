const test = require('node:test')
const assert = require('node:assert/strict')

const telemetry = require('../lib/telemetry')

test('telemetry', async (t) => {
  t.beforeEach(() => telemetry.reset())

  await t.test('summary aggregates by phase with counts, ms and tokens', () => {
    telemetry.record({ label: 'hatch:propose', ms: 100, ok: true, inputTokens: 10, outputTokens: 5 })
    telemetry.record({ label: 'hatch:generate:entity', ms: 300, ok: true, inputTokens: 20, outputTokens: 40 })
    telemetry.record({ label: 'hatch:generate:concept', ms: 500, ok: false, inputTokens: 20, outputTokens: 0, error: 'boom' })

    const s = telemetry.summary()
    assert.equal(s.totalCalls, 3)
    assert.equal(s.okCalls, 2)
    assert.equal(s.failedCalls, 1)
    assert.equal(s.wallLlmMs, 900)
    assert.deepEqual(s.tokens, { input: 50, output: 45 })

    // hatch:generate:<type> collapses to one "hatch:generate" phase
    assert.equal(s.byPhase['hatch:generate'].calls, 2)
    assert.equal(s.byPhase['hatch:generate'].ms, 800)
    assert.equal(s.byPhase['hatch:generate'].avgMs, 400)
    assert.equal(s.byPhase['hatch:generate'].failures, 1)
    assert.equal(s.byPhase['hatch:propose'].calls, 1)
  })

  await t.test('slowestCalls is ms-desc, capped at 5, and content-free', () => {
    for (const ms of [50, 900, 200, 700, 10, 400]) {
      telemetry.record({ label: 'x', ms, ok: true, prompt: 'SECRET', responseText: 'SECRET' })
    }
    const s = telemetry.summary()
    assert.deepEqual(s.slowestCalls.map((c) => c.ms), [900, 700, 400, 200, 50])
    assert.equal(JSON.stringify(s).includes('SECRET'), false)
    for (const c of s.slowestCalls) {
      assert.ok(!('prompt' in c) && !('responseText' in c))
    }
  })

  await t.test('withPhase tags records that carry no label of their own', async () => {
    await telemetry.withPhase('peck:answer', async () => {
      telemetry.record({ ms: 1, ok: true })
    })
    assert.equal(telemetry.entries()[0].phase, 'peck:answer')
  })

  await t.test('entries()/summary() never carry prompt or response text; the onTrace sink does', () => {
    const seen = []
    telemetry.onTrace((rec) => seen.push(rec))
    telemetry.record({ label: 'x', ms: 5, ok: true, system: 'S', prompt: 'P', responseText: 'R', reasoning: 'T' })

    const e = telemetry.entries()[0]
    for (const k of ['system', 'prompt', 'responseText', 'reasoning']) {
      assert.ok(!(k in e), `entries() leaked ${k}`)
    }
    assert.equal(seen.length, 1)
    assert.equal(seen[0].prompt, 'P')
    assert.equal(seen[0].responseText, 'R')
    assert.equal(seen[0].reasoning, 'T')
  })

  await t.test('reset clears records and the trace sink', () => {
    const seen = []
    telemetry.onTrace((rec) => seen.push(rec))
    telemetry.record({ label: 'a', ms: 1, ok: true })
    assert.equal(telemetry.entries().length, 1)

    telemetry.reset()
    telemetry.record({ label: 'b', ms: 1, ok: true })
    assert.equal(telemetry.entries().length, 1)
    assert.equal(seen.length, 1, 'sink from before reset must not still be receiving records')
  })
})
