/**
 * Workspace thin-slice core (engine v0.3.0): repo: source grammar, registry-resolved
 * existence-only verdicts, anchorRepo freshness redirection, new layer dirs.
 */
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { commit, makeGitRepo, makeTmpDir, writeDoc, writeRepoFile } from './helpers.mjs'
import { parseSource, SourceError } from '../lib/sources.mjs'
import { clearRegistryCache, resolveRepoPath } from '../lib/registry.mjs'
import { resolveFreshnessRepo } from '../lib/discover.mjs'
import { scanStore, generateIndex } from '../lib/indexgen.mjs'
import { staleAll, VERDICT } from '../lib/stale.mjs'

/** Point the registry resolver at a fresh dir holding one registry file. */
function makeRegistry(repos) {
    const dir = makeTmpDir()
    writeFileSync(
        path.join(dir, 'w.json'),
        JSON.stringify({ schema: 1, name: 'w', repos }, null, 4),
    )
    process.env.KAUT_WORKSPACES_DIR = dir
    clearRegistryCache()
    return dir
}

function only(store, repo, id) {
    const rows = staleAll(store, repo, 'master', [id])
    assert.equal(rows.length, 1, `expected exactly one row for ${id}`)
    return rows[0]
}

test('repo: source grammar parses name and path, strips fragments', () => {
    const s = parseSource('repo:alpha:file:migrations/V1__init.sql#L10')
    assert.equal(s.type, 'repo')
    assert.equal(s.repoName, 'alpha')
    assert.equal(s.repoFile, 'migrations/V1__init.sql')
    assert.equal(s.filePath, undefined) // not a local file-typed source
})

test('repo: source grammar rejects malformed values', () => {
    assert.throws(() => parseSource('repo:alpha:migrations/x.sql'), SourceError)
    assert.throws(() => parseSource('repo::file:x.sql'), SourceError)
    assert.throws(() => parseSource('repo:alpha:file:'), SourceError)
})

test('registry resolves member names; unknown name → null', () => {
    const repoB = makeGitRepo()
    makeRegistry([{ name: 'beta', path: repoB }])
    assert.equal(resolveRepoPath('beta'), repoB)
    assert.equal(resolveRepoPath('gamma'), null)
    delete process.env.KAUT_WORKSPACES_DIR
    clearRegistryCache()
})

test('repo: source healthy when the path exists at the member repo HEAD', () => {
    const repoA = makeGitRepo()
    writeRepoFile(repoA, 'src/a.ts', '1\n')
    const c1 = commit(repoA, 'add a')
    const repoB = makeGitRepo()
    writeRepoFile(repoB, 'db/x.sql', 'select 1;\n')
    commit(repoB, 'add sql')
    makeRegistry([{ name: 'beta', path: repoB }])

    const store = makeTmpDir()
    writeDoc(store, 'domains/x.md', { sources: ['file:src/a.ts', 'repo:beta:file:db/x.sql'], commit: c1 })
    assert.equal(only(store, repoA, 'domains/x').verdict, VERDICT.HEALTHY)
    delete process.env.KAUT_WORKSPACES_DIR
    clearRegistryCache()
})

test('repo: source broken when the path is absent at the member repo HEAD', () => {
    const repoA = makeGitRepo()
    writeRepoFile(repoA, 'src/a.ts', '1\n')
    const c1 = commit(repoA, 'add a')
    const repoB = makeGitRepo()
    makeRegistry([{ name: 'beta', path: repoB }])

    const store = makeTmpDir()
    writeDoc(store, 'domains/x.md', { sources: ['file:src/a.ts', 'repo:beta:file:db/gone.sql'], commit: c1 })
    const r = only(store, repoA, 'domains/x')
    assert.equal(r.verdict, VERDICT.BROKEN)
    assert.deepEqual(r.affected, ['repo:beta:file:db/gone.sql'])
    delete process.env.KAUT_WORKSPACES_DIR
    clearRegistryCache()
})

test('repo: source with unknown repo / missing registry → stale with a note (err toward stale)', () => {
    const repoA = makeGitRepo()
    writeRepoFile(repoA, 'src/a.ts', '1\n')
    const c1 = commit(repoA, 'add a')
    makeRegistry([]) // registry exists but knows no repos
    const store = makeTmpDir()
    writeDoc(store, 'domains/x.md', { sources: ['file:src/a.ts', 'repo:gamma:file:db/x.sql'], commit: c1 })
    const r = only(store, repoA, 'domains/x')
    assert.equal(r.verdict, VERDICT.STALE)
    assert.ok(r.notes.join(' ').includes('unverifiable'))

    // no registry dir at all → same degrade
    process.env.KAUT_WORKSPACES_DIR = path.join(makeTmpDir(), 'absent')
    clearRegistryCache()
    const r2 = only(store, repoA, 'domains/x')
    assert.equal(r2.verdict, VERDICT.STALE)
    delete process.env.KAUT_WORKSPACES_DIR
    clearRegistryCache()
})

test('anchorRepo: store config redirects freshness to another repo; absent → cwd repo', () => {
    const cwdRepo = makeGitRepo()
    const anchorRepo = makeGitRepo()
    const store = makeTmpDir()
    const d = { root: store, repo: cwdRepo, mainBranch: 'master' }

    // no config → old behavior
    assert.deepEqual(resolveFreshnessRepo(d), { repo: cwdRepo, mainBranch: 'master' })

    writeFileSync(
        path.join(store, 'kaut.config.json'),
        JSON.stringify({ schema: 1, project: { anchorRepo } }, null, 4),
    )
    const fr = resolveFreshnessRepo(d)
    assert.equal(fr.repo, anchorRepo)
    assert.equal(fr.mainBranch, 'master')

    // anchorRepo drives verdicts end-to-end: doc sources live in anchorRepo, not cwdRepo
    writeRepoFile(anchorRepo, 'compose.yml', 'services: {}\n')
    const cA = commit(anchorRepo, 'add compose')
    writeDoc(store, 'map/services.md', { sources: ['file:compose.yml'], commit: cA })
    assert.equal(only(store, fr.repo, 'map/services').verdict, VERDICT.HEALTHY)
})

test('new layer dirs (contracts/runbook/bootstrap) are scanned and validate by id=path', () => {
    const store = makeTmpDir()
    writeDoc(store, 'bootstrap/plan.md')
    writeDoc(store, 'runbook/local-debug.md')
    writeDoc(store, 'contracts/frontend-bridge.md')
    const rels = scanStore(store)
    assert.deepEqual(rels, ['bootstrap/plan.md', 'contracts/frontend-bridge.md', 'runbook/local-debug.md'])
    const { invalid, docs } = generateIndex(store, 'test-project')
    assert.equal(invalid.length, 0)
    assert.equal(docs.length, 3)
})

test('mixed doc: local file stays diffable while repo: source is existence-only', () => {
    const repoA = makeGitRepo()
    writeRepoFile(repoA, 'src/a.ts', '1\n')
    const c1 = commit(repoA, 'add a')
    const repoB = makeGitRepo()
    writeRepoFile(repoB, 'db/x.sql', 'select 1;\n')
    commit(repoB, 'add sql')
    makeRegistry([{ name: 'beta', path: repoB }])

    const store = makeTmpDir()
    writeDoc(store, 'domains/x.md', { sources: ['file:src/a.ts', 'repo:beta:file:db/x.sql'], commit: c1 })

    // change the LOCAL source on main → stale via the normal diff path
    writeRepoFile(repoA, 'src/a.ts', '2\n')
    commit(repoA, 'change a')
    const r = only(store, repoA, 'domains/x')
    assert.equal(r.verdict, VERDICT.STALE)
    assert.deepEqual(r.affected, ['src/a.ts'])

    // change the MEMBER repo file → repo: stays healthy (existence-only, post-pilot scope)
    writeRepoFile(repoB, 'db/x.sql', 'select 2;\n')
    commit(repoB, 'change sql')
    const store2 = makeTmpDir()
    const repoA2 = makeGitRepo()
    writeRepoFile(repoA2, 'src/a.ts', '1\n')
    const c2 = commit(repoA2, 'add a')
    writeDoc(store2, 'domains/y.md', { sources: ['file:src/a.ts', 'repo:beta:file:db/x.sql'], commit: c2 })
    assert.equal(only(store2, repoA2, 'domains/y').verdict, VERDICT.HEALTHY)
    delete process.env.KAUT_WORKSPACES_DIR
    clearRegistryCache()
})
