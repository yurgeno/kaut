import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseSource, parseSources } from '../lib/sources.mjs'

test('parses all four source types', () => {
    assert.deepEqual(parseSource('file:src/router/routes.ts'), {
        type: 'file',
        value: 'src/router/routes.ts',
        raw: 'file:src/router/routes.ts',
        filePath: 'src/router/routes.ts',
    })
    assert.equal(parseSource('file-glob:packages/core/src/utils/**').type, 'file-glob')
    assert.equal(parseSource('ticket:TICKET-16576').value, 'TICKET-16576')
    assert.equal(parseSource('user:2026-06-10').type, 'user')
})

test('strips OpenAPI-style fragments into filePath, keeps raw value', () => {
    const s = parseSource('file:openapi/api-v1-openapi.yaml#/components/schemas/Contract')
    assert.equal(s.filePath, 'openapi/api-v1-openapi.yaml')
    assert.equal(s.value, 'openapi/api-v1-openapi.yaml#/components/schemas/Contract')
})

test('rejects junk', () => {
    assert.throws(() => parseSource('http:foo'), /invalid source/)
    assert.throws(() => parseSource('files:x'), /invalid source/)
    assert.throws(() => parseSource('file:'), /invalid source/)
    assert.throws(() => parseSource('file:   '), /empty value/)
    assert.throws(() => parseSource('just-a-path.ts'), /invalid source/)
})

test('parseSources collects errors instead of throwing', () => {
    const { sources, errors } = parseSources(['file:a.ts', 'bogus', 'ticket:TICKET-1'])
    assert.equal(sources.length, 2)
    assert.equal(errors.length, 1)
    assert.match(errors[0], /bogus/)
})
