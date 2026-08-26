import assert from 'node:assert/strict'
import { test } from 'node:test'
import { nearestDocs, renderLookup, renderMiss } from '../lib/lookup.mjs'

test('healthy T1 doc renders clean: meta line + full body, no hint', () => {
    const doc = {
        id: 'domains/routing',
        fields: { trust: 'T1', derived_from_commit: 'd638a6e7f7306908e856f08582f6826991c73590' },
        body: '## Pointers\n\n- a\n\n## Invariants\n\n- b\n',
    }
    const out = renderLookup(doc, { verdict: 'healthy', affected: [], notes: [] })
    assert.equal(
        out,
        '# kaut: domains/routing\n' +
            'trust: T1 (mechanical) · derived: d638a6e7f730 · healthy\n' +
            '\n' +
            '## Pointers\n\n- a\n\n## Invariants\n\n- b\n',
    )
    assert.ok(!out.includes('hint:'))
})

test('stale T2 doc returns partial: keeps Invariants/Decisions, omits the rest, adds hint', () => {
    const doc = {
        id: 'domains/search',
        fields: { trust: 'T2', derived_from_commit: 'abc123def4567890' },
        body: '## Pointers\n<!-- sources: file:x -->\n\n- ptr\n\n## Invariants\n\n- inv\n\n## Decisions\n\n- dec\n\n## Notes\n\n- note\n',
    }
    const out = renderLookup(doc, { verdict: 'stale', affected: ['a.ts', 'b.ts'], notes: [] })
    assert.equal(
        out,
        '# kaut: domains/search\n' +
            'trust: T2 (claimed) · derived: abc123def456 · ⚠ STALE — sources changed since derivation: a.ts, b.ts\n' +
            '\n' +
            '## Invariants\n\n- inv\n\n' +
            '## Decisions\n\n- dec\n\n' +
            'affected files: a.ts, b.ts\n' +
            '(2 sections omitted — re-derive from code)\n' +
            '\n' +
            'hint: T2+ content is claimed, not mechanical — verify against code before relying on it\n',
    )
})

test('broken T0 map omits non-kept sections and shows the regenerate hint', () => {
    const doc = {
        id: 'map/routes',
        fields: { trust: 'T0', derived_from_commit: '0123456789abcdef' },
        body: '## Pointers\n\n- table\n',
    }
    const out = renderLookup(doc, { verdict: 'broken', affected: ['file:src/gone.ts'], notes: [] })
    assert.ok(out.includes('⛔ BROKEN — source pattern(s) match nothing: file:src/gone.ts'))
    assert.ok(out.includes('(1 section omitted — re-derive from code)'))
    assert.ok(out.trimEnd().endsWith('hint: regenerable map — run "kaut map" to refresh'))
})

test('stale with no affected files falls back to the note', () => {
    const doc = { id: 'domains/x', fields: { trust: 'T1', derived_from_commit: 'deadbeefcafe' }, body: '## Pointers\n\n- a\n' }
    const out = renderLookup(doc, { verdict: 'stale', affected: [], notes: ['derivation commit not in repo — treating as stale'] })
    assert.ok(out.includes('⚠ STALE — derivation commit not in repo'))
})

test('healthy T0 map renders without any hint (clean)', () => {
    const doc = { id: 'map/packages', fields: { trust: 'T0', derived_from_commit: 'abcdef012345' }, body: '## Pointers\n\n- graph\n' }
    const out = renderLookup(doc, { verdict: 'healthy', affected: [], notes: [] })
    assert.ok(!out.includes('hint:'))
})

test('nearestDocs ranks substring and term hits', () => {
    const docs = [
        { id: 'domains/search', title: 'Search domain' },
        { id: 'domains/booking', title: 'Booking domain' },
        { id: 'map/routes', title: 'Route table' },
    ]
    assert.deepEqual(nearestDocs('search', docs), ['domains/search'])
    assert.deepEqual(nearestDocs('domains/booking', docs), ['domains/booking'])
    assert.deepEqual(nearestDocs('route', docs), ['map/routes'])
    assert.deepEqual(nearestDocs('nonsense-xyz', docs), [])
})

test('renderMiss lists nearest topics and exits via caller (exit 0 semantics)', () => {
    const out = renderMiss('domains/xyz', ['domains/search'])
    assert.ok(out.includes('miss: no doc "domains/xyz"'))
    assert.ok(out.includes('domains/search'))
    const empty = renderMiss('zzz', [])
    assert.ok(empty.includes('full catalog'))
})
