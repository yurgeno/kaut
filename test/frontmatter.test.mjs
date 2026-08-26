import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseFrontmatter, serializeFrontmatter } from '../lib/frontmatter.mjs'

const DOC = `---
id: domains/routing
title: Routing — where routes live
sources:
    - file:src/router/routes.ts
    - file-glob:packages/core/src/utils/**
derived_from_commit: ${'a'.repeat(40)}
harvested: 2026-06-10
engine: manual@0.1.0
tickets: []
trust: T1
checks: []
schema_version: 1
---

## Pointers

content
`

test('parses a contract-shaped document', () => {
    const { fields, body } = parseFrontmatter(DOC)
    assert.equal(fields.id, 'domains/routing')
    assert.equal(fields.title, 'Routing — where routes live')
    assert.deepEqual(fields.sources, ['file:src/router/routes.ts', 'file-glob:packages/core/src/utils/**'])
    assert.deepEqual(fields.tickets, [])
    assert.deepEqual(fields.checks, [])
    assert.equal(fields.schema_version, '1')
    assert.match(body, /## Pointers/)
})

test('round-trip: parse → serialize → parse yields identical fields and body', () => {
    const p1 = parseFrontmatter(DOC)
    const out = serializeFrontmatter(p1.fields, p1.body, p1.order)
    const p2 = parseFrontmatter(out)
    assert.deepEqual(p2.fields, p1.fields)
    assert.equal(p2.body, p1.body)
    // Serialization is stable: a second round-trip is byte-identical.
    assert.equal(serializeFrontmatter(p2.fields, p2.body, p2.order), out)
})

test('inline lists and comments', () => {
    const { fields } = parseFrontmatter(
        '---\nid: x # trailing comment\n# full-line comment\ntickets: [TICKET-1, TICKET-2]\nchecks: []\n---\nbody',
    )
    assert.equal(fields.id, 'x')
    assert.deepEqual(fields.tickets, ['TICKET-1', 'TICKET-2'])
    assert.deepEqual(fields.checks, [])
})

test('unknown keys are preserved through round-trip (tolerant reader)', () => {
    const src = '---\nid: x\nfuture_key: some value\n---\nbody'
    const p = parseFrontmatter(src)
    assert.equal(p.fields.future_key, 'some value')
    const out = serializeFrontmatter(p.fields, p.body, p.order)
    assert.equal(parseFrontmatter(out).fields.future_key, 'some value')
})

test('rejects documents outside the subset, with line numbers', () => {
    assert.throws(() => parseFrontmatter('no fence'), /must start with "---" \(line 1\)/)
    assert.throws(() => parseFrontmatter('---\nid: x\n'), /unterminated frontmatter/)
    assert.throws(() => parseFrontmatter('---\nid:x\n---\n'), /missing space after ":"/)
    assert.throws(() => parseFrontmatter('---\n- orphan item\n---\n'), /list item without an open list key \(line 2\)/)
    assert.throws(() => parseFrontmatter('---\nid: x\nid: y\n---\n'), /duplicate key "id" \(line 3\)/)
    assert.throws(() => parseFrontmatter('---\n???\n---\n'), /unrecognized frontmatter line/)
    assert.throws(() => parseFrontmatter('---\ntickets: [a, b\n---\n'), /unterminated inline list/)
})

test('bare "key:" opens an empty block list', () => {
    const { fields } = parseFrontmatter('---\nsources:\n---\nbody')
    assert.deepEqual(fields.sources, [])
})
