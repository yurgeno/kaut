/**
 * Usage digest — aggregation over journal records (A). Pure folds, so tested directly with synthetic
 * events (the CLI just sweeps registry store roots and feeds readJournal output in).
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { aggregate, renderDigest } from '../lib/digest.mjs'

const EVENTS = [
    { ts: '2026-06-20T10:00:00Z', store: 'a', op: 'lookup', topic: 'domains/x', verdict: 'healthy', trust: 'T1', altitude: 'landscape', mode: 'full' },
    { ts: '2026-06-20T10:01:00Z', store: 'a', op: 'lookup', topic: 'domains/x', verdict: 'stale', trust: 'T1', altitude: 'landscape', mode: 'partial' },
    { ts: '2026-06-20T10:02:00Z', store: 'a', op: 'lookup', topic: 'nope', mode: 'miss' },
    { ts: '2026-06-20T10:03:00Z', store: 'a', op: 'lookup', mode: 'catalog' },
    { ts: '2026-06-20T10:04:00Z', store: 'b', op: 'write', topic: 'runbook/r', tier: 'agent' },
    { ts: '2026-06-20T10:05:00Z', store: 'b', op: 'write', topic: 'domains/y', tier: 'owner-approved' },
    { ts: '2026-06-20T10:06:00Z', store: 'a', op: 'map', topic: 'map/services' },
    { ts: '2026-06-20T10:07:00Z', store: 'a', op: 'outcome', topic: 'domains/x', result: 'trusted' },
    { ts: '2026-06-20T10:08:00Z', store: 'a', op: 'outcome', topic: 'domains/x', result: 'confirmed' },
]

test('aggregate: totals, modes, hit/miss rate', () => {
    const s = aggregate(EVENTS, ['a', 'b'])
    assert.equal(s.totals.events, 9)
    assert.equal(s.totals.lookups, 4)
    assert.equal(s.totals.writes, 2)
    assert.equal(s.totals.maps, 1)
    assert.equal(s.totals.outcomes, 2)
    assert.equal(s.totals.stores, 2)
    assert.equal(s.lookups.hits, 2) // full + partial
    assert.equal(s.lookups.misses, 1)
    assert.equal(s.lookups.hitRate, 0.67) // 2 / (2+1)
    assert.equal(s.lookups.byMode.catalog, 1)
    assert.deepEqual(s.lookups.byVerdict, { healthy: 1, stale: 1 })
    assert.equal(s.lookups.byAltitude.landscape, 2)
    assert.equal(s.range.from, '2026-06-20T10:00:00Z')
    assert.equal(s.range.to, '2026-06-20T10:08:00Z')
})

test('aggregate: writes by tier, outcomes by result', () => {
    const s = aggregate(EVENTS, ['a', 'b'])
    assert.deepEqual(s.writes.byTier, { agent: 1, 'owner-approved': 1 })
    assert.deepEqual(s.outcomes.byResult, { trusted: 1, confirmed: 1 })
})

test('aggregate: top topics carry miss/stale/outcome flags', () => {
    const s = aggregate(EVENTS, ['a', 'b'])
    const x = s.topTopics.find((t) => t.topic === 'domains/x')
    assert.equal(x.lookups, 2)
    assert.equal(x.stale, 1)
    assert.equal(x.outcomes.trusted, 1)
    assert.equal(x.outcomes.confirmed, 1)
    const nope = s.topTopics.find((t) => t.topic === 'nope')
    assert.equal(nope.miss, 1)
    assert.equal(s.topTopics[0].topic, 'domains/x') // sorted by reads desc
})

test('aggregate: per-store tallies (incl. an empty store)', () => {
    const s = aggregate(EVENTS, ['a', 'b', 'empty'])
    assert.equal(s.byStore.a.lookups, 4)
    assert.equal(s.byStore.a.misses, 1)
    assert.equal(s.byStore.a.outcomes, 2)
    assert.equal(s.byStore.b.writes, 2)
    assert.deepEqual(s.byStore.empty, { lookups: 0, misses: 0, writes: 0, outcomes: 0 })
})

test('renderDigest: empty vs populated', () => {
    assert.match(renderDigest(aggregate([], [])), /no telemetry yet/)
    const out = renderDigest(aggregate(EVENTS, ['a', 'b']))
    assert.match(out, /hit rate 67%/)
    assert.match(out, /domains\/x/)
    assert.match(out, /trusted: 1/)
    assert.match(out, /coverage gaps \(only ever missed\): nope/) // 'nope' was only ever a miss
})
