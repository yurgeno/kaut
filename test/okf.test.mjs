/**
 * OKF (Open Knowledge Format) conformance — the additive `type` key (vector B7-α).
 * `type` == the doc's layer; optional in frontmatter (back-derived from the id when absent),
 * consistency-checked when present, and stamped into engine-generated docs for in-place
 * conformance. Contract: SCHEMA §22–23.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { serializeFrontmatter } from '../lib/frontmatter.mjs'
import { typeForId, validateDoc } from '../lib/indexgen.mjs'
import { renderServicesDoc } from '../lib/composemap.mjs'

/** A minimal valid doc body with the given frontmatter lines spliced in. */
function doc(id, extraLines = []) {
    return [
        '---',
        `id: ${id}`,
        ...extraLines,
        'title: T',
        'sources:',
        '    - file:src/a.ts',
        'derived_from_commit: ' + 'a'.repeat(40),
        'harvested: 2026-06-18',
        'engine: manual@0.3.0',
        'tickets: []',
        'trust: T1',
        'checks: []',
        'schema_version: 1',
        '---',
        '',
        '## Pointers',
        '',
        '- x',
        '',
    ].join('\n')
}

test('typeForId: the OKF type is the first id segment (the layer)', () => {
    assert.equal(typeForId('domains/booking'), 'domains')
    assert.equal(typeForId('map/routes'), 'map')
    assert.equal(typeForId('decisions/nested/thing'), 'decisions')
})

test('validateDoc: a doc that OMITS type is still valid (type is back-derived, no rewrite)', () => {
    const v = validateDoc('domains/x.md', doc('domains/x'))
    assert.equal(v.ok, true)
    assert.equal(typeForId('domains/x'), 'domains') // what a reader/exporter would present
})

test('validateDoc: an explicit type matching the layer is valid', () => {
    const v = validateDoc('domains/x.md', doc('domains/x', ['type: domains']))
    assert.equal(v.ok, true)
})

test('validateDoc: an explicit type that disagrees with the layer is invalid', () => {
    const v = validateDoc('domains/x.md', doc('domains/x', ['type: decisions']))
    assert.equal(v.ok, false)
    assert.ok(v.errors.join(' ').includes('type "decisions" does not match layer'))
})

test('serializeFrontmatter: type renders right after id (OKF puts type first)', () => {
    const out = serializeFrontmatter({ id: 'map/x', type: 'map', title: 'T' }, 'body')
    const lines = out.split('\n')
    assert.equal(lines[0], '---')
    assert.equal(lines[1], 'id: map/x')
    assert.equal(lines[2], 'type: map')
})

test('compose map: an engine-generated doc is stamped type: map and is OKF-conformant in place', () => {
    const services = [
        { name: 'web', image: 'nginx', ports: ['80:80'], dependsOn: [], containerName: 'web' },
    ]
    const content = renderServicesDoc(services, { derived: 'b'.repeat(40), harvested: '2026-06-18', version: '0.3.0' }, 'docker-compose.yml')
    assert.ok(content.includes('type: map'), 'stamped type: map')
    const v = validateDoc('map/services.md', content)
    assert.equal(v.ok, true) // type matches the layer → valid
    assert.equal(v.fields.type, 'map')
})
