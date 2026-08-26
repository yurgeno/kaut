import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { appendJournal, readJournal } from '../lib/journal.mjs'
import { makeTmpDir } from './helpers.mjs'

test('append then read back, in order, with stamped ts', () => {
    const root = makeTmpDir()
    appendJournal(root, { op: 'lookup', topic: 'domains/routing', verdict: 'healthy', trust: 'T1', mode: 'full', branch: 'master', ts: '2026-06-11T09:00:00Z' })
    appendJournal(root, { op: 'map', topic: 'map/routes', verdict: null, trust: 'T0', mode: 'full', branch: 'master', ts: '2026-06-11T09:05:00Z' })
    const records = readJournal(root)
    assert.equal(records.length, 2)
    assert.equal(records[0].op, 'lookup')
    assert.equal(records[0].topic, 'domains/routing')
    assert.equal(records[0].ts, '2026-06-11T09:00:00Z')
    assert.equal(records[1].op, 'map')
})

test('ts is auto-stamped when omitted', () => {
    const root = makeTmpDir()
    appendJournal(root, { op: 'lookup', topic: 'x', mode: 'miss' })
    const [r] = readJournal(root)
    assert.match(r.ts, /^\d{4}-\d{2}-\d{2}T/)
})

test('missing journal reads as empty', () => {
    assert.deepEqual(readJournal(makeTmpDir()), [])
})

test('malformed lines are skipped, not fatal', () => {
    const root = makeTmpDir()
    appendJournal(root, { op: 'lookup', topic: 'a', ts: '2026-01-01T00:00:00Z' })
    writeFileSync(path.join(root, 'journal.jsonl'), '{not json}\n', { flag: 'a' })
    appendJournal(root, { op: 'lookup', topic: 'b', ts: '2026-01-02T00:00:00Z' })
    const warnings = []
    const records = readJournal(root, { warn: (s) => warnings.push(s) })
    assert.equal(records.length, 2)
    assert.deepEqual(records.map((r) => r.topic), ['a', 'b'])
    assert.equal(warnings.length, 1)
})
