import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseSections } from '../lib/sections.mjs'

const BODY = `
## Pointers
<!-- sources: file:src/router/routes.ts -->
<!-- trust: T1 -->

- Route table lives here.

## Invariants
<!-- sources: file:src/router/routes.ts, file-glob:packages/core/src/utils/** -->
<!-- trust: T1 (mechanical) -->

- Routes reference ROUTER_PATH constants.

### Sub-detail
Still part of Invariants.
`

test('splits level-2 sections with bindings', () => {
    const { sections } = parseSections(BODY)
    assert.equal(sections.length, 2)
    assert.equal(sections[0].heading, 'Pointers')
    assert.deepEqual(sections[0].sources, ['file:src/router/routes.ts'])
    assert.equal(sections[0].trust, 'T1')
    assert.equal(sections[0].text, '- Route table lives here.')
})

test('multiple comma-separated sources parse', () => {
    const { sections } = parseSections(BODY)
    assert.deepEqual(sections[1].sources, [
        'file:src/router/routes.ts',
        'file-glob:packages/core/src/utils/**',
    ])
    assert.equal(sections[1].trust, 'T1 (mechanical)')
})

test('### subheadings stay as section content, not new sections', () => {
    const { sections } = parseSections(BODY)
    assert.ok(sections[1].text.includes('### Sub-detail'))
    assert.ok(sections[1].text.includes('Still part of Invariants.'))
})

test('preamble before the first heading is captured', () => {
    const { preamble, sections } = parseSections('intro line\n\n## A\nbody')
    assert.equal(preamble, 'intro line')
    assert.equal(sections.length, 1)
    assert.equal(sections[0].heading, 'A')
})

test('a binding comment after body text is content, not a binding', () => {
    const { sections } = parseSections('## A\ntext first\n<!-- sources: file:x -->')
    assert.deepEqual(sections[0].sources, [])
    assert.ok(sections[0].text.includes('<!-- sources: file:x -->'))
})

test('section without bindings yields empty sources / null trust', () => {
    const { sections } = parseSections('## Notes\n\nplain text only')
    assert.deepEqual(sections[0].sources, [])
    assert.equal(sections[0].trust, null)
    assert.equal(sections[0].text, 'plain text only')
})
