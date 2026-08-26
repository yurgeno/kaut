import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { commit, git, makeGitRepo, makeTmpDir, writeDoc, writeRepoFile } from './helpers.mjs'
import { staleAll, VERDICT } from '../lib/stale.mjs'

/**
 * Evaluate a single doc id against a repo/store pair on the `master` main branch.
 * @returns {{id: string, verdict: string|null, affected: string[], notes: string[]}}
 */
function only(store, repo, id) {
    const rows = staleAll(store, repo, 'master', [id])
    assert.equal(rows.length, 1, `expected exactly one row for ${id}`)
    return rows[0]
}

test('healthy when derived == anchor and sources unchanged', () => {
    const repo = makeGitRepo()
    writeRepoFile(repo, 'src/routes.ts', 'export const a = 1\n')
    const c1 = commit(repo, 'add routes')
    const store = makeTmpDir()
    writeDoc(store, 'domains/x.md', { sources: ['file:src/routes.ts'], commit: c1 })
    assert.equal(only(store, repo, 'domains/x').verdict, VERDICT.HEALTHY)
})

test('stale when a source changes on main after derivation', () => {
    const repo = makeGitRepo()
    writeRepoFile(repo, 'src/routes.ts', 'export const a = 1\n')
    const c1 = commit(repo, 'add routes')
    const store = makeTmpDir()
    writeDoc(store, 'domains/x.md', { sources: ['file:src/routes.ts'], commit: c1 })
    writeRepoFile(repo, 'src/routes.ts', 'export const a = 2\n')
    commit(repo, 'change routes')
    const r = only(store, repo, 'domains/x')
    assert.equal(r.verdict, VERDICT.STALE)
    assert.deepEqual(r.affected, ['src/routes.ts'])
})

test('broken when a file source matches nothing at the anchor', () => {
    const repo = makeGitRepo()
    writeRepoFile(repo, 'src/routes.ts', 'x\n')
    const c1 = commit(repo, 'add routes')
    const store = makeTmpDir()
    writeDoc(store, 'domains/x.md', { sources: ['file:src/gone.ts'], commit: c1 })
    assert.equal(only(store, repo, 'domains/x').verdict, VERDICT.BROKEN)
})

test('broken beats stale on a renamed source', () => {
    const repo = makeGitRepo()
    writeRepoFile(repo, 'src/routes.ts', 'x\n')
    const c1 = commit(repo, 'add routes')
    const store = makeTmpDir()
    writeDoc(store, 'domains/x.md', { sources: ['file:src/routes.ts'], commit: c1 })
    git(repo, ['mv', 'src/routes.ts', 'src/router.ts'])
    commit(repo, 'rename routes')
    // derived c1 is an ancestor of the rename commit (ancestry check passes); the dead pattern => broken
    assert.equal(only(store, repo, 'domains/x').verdict, VERDICT.BROKEN)
})

test('branch-advisory is ephemeral and never flaps the stored verdict (M2)', () => {
    const repo = makeGitRepo()
    writeRepoFile(repo, 'src/routes.ts', 'v1\n')
    const c = commit(repo, 'add routes')
    const store = makeTmpDir()
    writeDoc(store, 'domains/x.md', { sources: ['file:src/routes.ts'], commit: c })

    git(repo, ['checkout', '--quiet', '-b', 'feature'])
    writeRepoFile(repo, 'src/routes.ts', 'v2\n')
    commit(repo, 'feature edit')
    const onBranch = only(store, repo, 'domains/x')
    assert.equal(onBranch.verdict, VERDICT.ADVISORY)
    assert.deepEqual(onBranch.affected, ['src/routes.ts'])

    git(repo, ['checkout', '--quiet', 'master'])
    // back on main the ephemeral advisory is gone; the stored class was healthy both times
    assert.equal(only(store, repo, 'domains/x').verdict, VERDICT.HEALTHY)
})

test('uncommitted working-tree edits count as branch advisory', () => {
    const repo = makeGitRepo()
    writeRepoFile(repo, 'src/routes.ts', 'v1\n')
    const c = commit(repo, 'add routes')
    const store = makeTmpDir()
    writeDoc(store, 'domains/x.md', { sources: ['file:src/routes.ts'], commit: c })
    writeRepoFile(repo, 'src/routes.ts', 'dirty\n') // modified, not committed
    assert.equal(only(store, repo, 'domains/x').verdict, VERDICT.ADVISORY)
})

test('D4: unknown derivation commit => stale (err toward stale)', () => {
    const repo = makeGitRepo()
    writeRepoFile(repo, 'src/routes.ts', 'x\n')
    commit(repo, 'add routes')
    const store = makeTmpDir()
    writeDoc(store, 'domains/x.md', { sources: ['file:src/routes.ts'], commit: 'd'.repeat(40) })
    const r = only(store, repo, 'domains/x')
    assert.equal(r.verdict, VERDICT.STALE)
    assert.ok(r.notes.join(' ').includes('not in repo'))
})

test('D4: non-ancestor derivation commit => stale', () => {
    const repo = makeGitRepo()
    writeRepoFile(repo, 'src/routes.ts', 'x\n')
    commit(repo, 'add routes')
    git(repo, ['checkout', '--quiet', '-b', 'feature'])
    writeRepoFile(repo, 'src/routes.ts', 'y\n')
    const cFeature = commit(repo, 'feature commit')
    git(repo, ['checkout', '--quiet', 'master'])
    const store = makeTmpDir()
    writeDoc(store, 'domains/x.md', { sources: ['file:src/routes.ts'], commit: cFeature })
    const r = only(store, repo, 'domains/x')
    assert.equal(r.verdict, VERDICT.STALE)
    assert.ok(r.notes.join(' ').includes('main history'))
})

test('false-stale fix: a doc derived ahead of an old branch’s anchor is fresh, not stale', () => {
    const repo = makeGitRepo()
    writeRepoFile(repo, 'src/routes.ts', 'v1\n')
    commit(repo, 'c1 routes')
    // an old ticket branch forks from c1 (its sources untouched on the branch)
    git(repo, ['checkout', '--quiet', '-b', 'old-ticket'])
    git(repo, ['checkout', '--quiet', 'master'])
    // main advances with an UNRELATED file; src/routes.ts is unchanged at c2
    writeRepoFile(repo, 'src/other.ts', 'x\n')
    const c2 = commit(repo, 'c2 unrelated')
    const store = makeTmpDir()
    writeDoc(store, 'domains/x.md', { sources: ['file:src/routes.ts'], commit: c2 })
    // read from the old branch, whose merge-base (c1) predates the doc's derivation (c2)
    git(repo, ['checkout', '--quiet', 'old-ticket'])
    const r = only(store, repo, 'domains/x')
    assert.equal(r.verdict, VERDICT.HEALTHY) // was STALE before the false-stale fix
    assert.ok(r.notes.join(' ').includes('ahead of this branch'))
})

test('false-stale fix: an ahead-of-anchor doc still flags branch-advisory when the branch edits the source', () => {
    const repo = makeGitRepo()
    writeRepoFile(repo, 'src/routes.ts', 'v1\n')
    commit(repo, 'c1 routes')
    // old branch forks from c1 and edits the very source the doc points at
    git(repo, ['checkout', '--quiet', '-b', 'old-ticket'])
    writeRepoFile(repo, 'src/routes.ts', 'branch-edit\n')
    commit(repo, 'branch edits routes')
    // main advances ahead of c1 with an unrelated file; the doc is derived there
    git(repo, ['checkout', '--quiet', 'master'])
    writeRepoFile(repo, 'src/other.ts', 'x\n')
    const c2 = commit(repo, 'c2 unrelated')
    const store = makeTmpDir()
    writeDoc(store, 'domains/x.md', { sources: ['file:src/routes.ts'], commit: c2 })
    git(repo, ['checkout', '--quiet', 'old-ticket'])
    const r = only(store, repo, 'domains/x')
    assert.equal(r.verdict, VERDICT.ADVISORY) // ahead ⇒ not stale, but the branch touches the source
    assert.deepEqual(r.affected, ['src/routes.ts'])
})

test('provenance-only sources never go stale or broken', () => {
    const repo = makeGitRepo()
    writeRepoFile(repo, 'src/routes.ts', 'x\n')
    const c = commit(repo, 'add routes')
    const store = makeTmpDir()
    writeDoc(store, 'decisions/y.md', {
        sources: ['ticket:TICKET-1', 'user:2026-01-01'],
        commit: c,
        trust: 'T3',
    })
    writeRepoFile(repo, 'src/routes.ts', 'changed\n')
    commit(repo, 'churn')
    assert.equal(only(store, repo, 'decisions/y').verdict, VERDICT.HEALTHY)
})

test('per-section: one stale section makes the doc stale with union affected', () => {
    const repo = makeGitRepo()
    writeRepoFile(repo, 'src/a.ts', '1\n')
    writeRepoFile(repo, 'src/b.ts', '1\n')
    const c1 = commit(repo, 'add a,b')
    const store = makeTmpDir()
    const doc = [
        '---',
        'id: domains/multi',
        'title: Multi',
        'sources:',
        '    - file:src/a.ts',
        '    - file:src/b.ts',
        `derived_from_commit: ${c1}`,
        'harvested: 2026-06-11',
        'engine: manual@0.2.0',
        'tickets: []',
        'trust: T1',
        'checks: []',
        'schema_version: 1',
        '---',
        '',
        '## Pointers',
        '<!-- sources: file:src/a.ts -->',
        '',
        '- a',
        '',
        '## Invariants',
        '<!-- sources: file:src/b.ts -->',
        '',
        '- b',
        '',
    ].join('\n')
    mkdirSync(path.join(store, 'domains'), { recursive: true })
    writeFileSync(path.join(store, 'domains', 'multi.md'), doc)
    writeRepoFile(repo, 'src/b.ts', '2\n')
    commit(repo, 'change b')
    const r = only(store, repo, 'domains/multi')
    assert.equal(r.verdict, VERDICT.STALE)
    assert.deepEqual(r.affected, ['src/b.ts'])
})

test('disputed frontmatter flag wins over everything', () => {
    const repo = makeGitRepo()
    writeRepoFile(repo, 'src/routes.ts', 'x\n')
    const c = commit(repo, 'add routes')
    const store = makeTmpDir()
    writeDoc(store, 'domains/x.md', {
        sources: ['file:src/routes.ts'],
        commit: c,
        extra: 'disputed: true',
    })
    assert.equal(only(store, repo, 'domains/x').verdict, VERDICT.DISPUTED)
})
