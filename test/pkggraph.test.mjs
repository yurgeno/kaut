import assert from 'node:assert/strict'
import { test } from 'node:test'
import { makeTmpDir, writeRepoFile } from './helpers.mjs'
import { parsePackageGraph, renderPackagesDoc } from '../lib/pkggraph.mjs'
import { validateDoc } from '../lib/indexgen.mjs'

/** Build a 3-package fixture: a→b (two files, one static + one dynamic, plus a self-ref), c→b. */
function fixture() {
    const repo = makeTmpDir()
    writeRepoFile(repo, 'packages/a/src/one.ts', "import { X } from '@packages/b/service'\n")
    writeRepoFile(
        repo,
        'packages/a/src/two.ts',
        "const v = () => import('@packages/b/views').then((m) => m.V)\nimport { I } from '@packages/a/internal'\n",
    )
    writeRepoFile(repo, 'packages/b/src/y.ts', 'export const y = 1\n')
    writeRepoFile(repo, 'packages/c/src/z.vue', "<script setup>\nimport { Z } from '@packages/b/x'\n</script>\n")
    return repo
}

test('parsePackageGraph builds weighted edges with no self-edges', () => {
    const g = parsePackageGraph(fixture())
    assert.deepEqual(g.packages, ['a', 'b', 'c'])
    assert.deepEqual(g.edges, [
        { from: 'a', to: 'b', weight: 2 }, // two files import b; the @packages/a self-ref is ignored
        { from: 'c', to: 'b', weight: 1 },
    ])
})

test('renderPackagesDoc is deterministic and contract-valid', () => {
    const content = renderPackagesDoc(parsePackageGraph(fixture()), {
        derived: 'a'.repeat(40),
        harvested: '2026-06-11',
        version: '0.2.0',
    })
    const v = validateDoc('map/packages.md', content)
    assert.ok(v.ok, v.ok ? '' : JSON.stringify(v.errors))
    assert.ok(content.includes('| a | b(2) | 0 |'))
    assert.ok(content.includes('| b | (none) | 2 |'))
    assert.ok(content.includes('| c | b(1) | 0 |'))
    assert.ok(content.includes('engine: pkg-graph@0.2.0'))
})

test('directories without a src/ are not packages', () => {
    const repo = makeTmpDir()
    writeRepoFile(repo, 'packages/a/src/x.ts', 'export const x = 1\n')
    writeRepoFile(repo, 'packages/notapkg/readme.md', 'no src here\n')
    assert.deepEqual(parsePackageGraph(repo).packages, ['a'])
})
