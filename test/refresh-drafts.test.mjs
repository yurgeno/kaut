/**
 * ROT blocks 2+3+5.1: refresh delta bundles, the draft queue (asynchronous owner gate), and
 * the change-site sensor (`touched`).
 *
 * Lib-level: buildRefresh statuses (delta/current/mechanical/wrong-repo/off-main), section
 * mapping, dead-pattern re-bind lists. CLI-level: the draft→review round trip against the
 * real gate (a writePolicy that owner-gates the layer refuses `index` but ACCEPTS a draft,
 * and `review --approve` lands it with the owner-approved audit tag), the draft-door anchor
 * guards, doctor/lookup queue visibility, and `touched` matching doc+section bindings.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { commitAll, ensureStoreGit } from '../lib/gitstore.mjs'
import { buildRefresh, REFRESH } from '../lib/refresh.mjs'
import { draftPath, listDrafts } from '../lib/drafts.mjs'
import { readJournal } from '../lib/journal.mjs'
import { clearRegistryCache } from '../lib/registry.mjs'
import { commit, git, makeGitRepo, makeTmpDir, writeDoc, writeRepoFile } from './helpers.mjs'

const KAUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'kaut.mjs')

/** Committed store fixture: config + layer dirs + one doc bound to src/a.ts at the repo HEAD. */
function makeStore(repo, { withConfig = true } = {}) {
    const root = makeTmpDir()
    ensureStoreGit(root)
    writeFileSync(path.join(root, '.gitignore'), '.lock/\n*.tmp\njournal.jsonl\n.DS_Store\n')
    if (withConfig) writeFileSync(path.join(root, 'kaut.config.json'), JSON.stringify({ schema: 1 }) + '\n')
    for (const dir of ['map', 'domains', 'decisions']) mkdirSync(path.join(root, dir), { recursive: true })
    writeRepoFile(repo, 'src/a.ts', 'export const a = 1\n')
    const sha = commit(repo, 'add source')
    writeDoc(root, 'domains/demo.md', { sources: ['file:src/a.ts'], commit: sha })
    commitAll(root, 'kaut: test fixture')
    return { root, sha }
}

/** Run the CLI against a fixture repo/store (+ optional extra env, e.g. a registry dir). */
function kaut(repo, root, args, extraEnv = {}) {
    try {
        const stdout = execFileSync('node', [KAUT, ...args], {
            cwd: repo,
            encoding: 'utf8',
            env: { ...process.env, KAUT_ROOT: root, ...extraEnv },
        })
        return { stdout, code: 0 }
    } catch (e) {
        return { stdout: `${e.stdout ?? ''}${e.stderr ?? ''}`, code: e.status ?? 1 }
    }
}

/** A registry dir owner-gating every layer of `storeRoot` (async-gate interplay fixture). */
function ownerGatedRegistry(storeRoot) {
    const dir = makeTmpDir()
    writeFileSync(
        path.join(dir, 't.json'),
        JSON.stringify({ schema: 1, name: 't', repos: [{ name: 'r', storeRoot, writePolicy: { '*': 'owner' } }] }),
    )
    return dir
}

// ---------- refresh (lib) ----------

test('refresh: changed source → delta with git status + directive at the main tip', () => {
    const repo = makeGitRepo()
    const { root } = makeStore(repo)
    writeRepoFile(repo, 'src/a.ts', 'export const a = 2\n')
    const tip = commit(repo, 'change source')
    const { target, rows } = buildRefresh(root, repo, 'master')
    assert.equal(target, tip)
    const r = rows.find((x) => x.id === 'domains/demo')
    assert.equal(r.status, REFRESH.DELTA)
    assert.deepEqual(r.changed, [{ path: 'src/a.ts', gitStatus: 'M' }])
    assert.match(r.directive, new RegExp(tip.slice(0, 12)))
    assert.match(r.directive, new RegExp(`derived_from_commit: ${tip}`))
})

test('refresh: untouched source → current, no directive', () => {
    const repo = makeGitRepo()
    const { root } = makeStore(repo)
    const { rows } = buildRefresh(root, repo, 'master')
    assert.equal(rows[0].status, REFRESH.CURRENT)
    assert.equal(rows[0].directive, undefined)
})

test('refresh: deleted source → delta with D status AND re-bind list', () => {
    const repo = makeGitRepo()
    const { root } = makeStore(repo)
    git(repo, ['rm', '--quiet', 'src/a.ts'])
    commit(repo, 'drop source')
    const { rows } = buildRefresh(root, repo, 'master')
    const r = rows[0]
    assert.equal(r.status, REFRESH.DELTA)
    assert.deepEqual(r.changed, [{ path: 'src/a.ts', gitStatus: 'D' }])
    assert.deepEqual(r.broken, ['file:src/a.ts'])
})

test('refresh: anchor from another repo → wrong-repo-anchor (full re-derive directive)', () => {
    const repo = makeGitRepo()
    const other = makeGitRepo()
    // distinct content — two fixtures born in the same second would otherwise produce the
    // IDENTICAL init sha (same tree, same message, same timestamps), making the anchor resolvable
    writeRepoFile(other, 'foreign.txt', 'foreign\n')
    const { root } = makeStore(repo)
    const foreign = commit(other, 'foreign commit')
    writeDoc(root, 'domains/foreign.md', { sources: ['file:src/a.ts'], commit: foreign })
    commitAll(root, 'kaut: add foreign-anchored doc')
    const { rows } = buildRefresh(root, repo, 'master', ['domains/foreign'])
    assert.equal(rows[0].status, REFRESH.WRONG_REPO)
    assert.ok(rows[0].directive)
})

test('refresh: branch-anchored doc → off-main-anchor', () => {
    const repo = makeGitRepo()
    const { root } = makeStore(repo)
    git(repo, ['checkout', '--quiet', '-b', 'ticket'])
    writeRepoFile(repo, 'src/branch.ts', 'x\n')
    const branchSha = commit(repo, 'branch-only work')
    git(repo, ['checkout', '--quiet', 'master'])
    writeDoc(root, 'domains/branchy.md', { sources: ['file:src/a.ts'], commit: branchSha })
    commitAll(root, 'kaut: add branch-anchored doc')
    const { rows } = buildRefresh(root, repo, 'master', ['domains/branchy'])
    assert.equal(rows[0].status, REFRESH.OFF_MAIN)
})

test('refresh: adapter-generated map → mechanical (regenerate, never hand-rewrite)', () => {
    const repo = makeGitRepo()
    const { root, sha } = makeStore(repo)
    writeDoc(root, 'map/routes.md', { sources: ['file:src/a.ts'], commit: sha })
    // writeDoc stamps engine: manual@… — overwrite provenance to the adapter's
    const p = path.join(root, 'map/routes.md')
    writeFileSync(p, readFileSync(p, 'utf8').replace('engine: manual@0.1.0', 'engine: route-map@0.3.0'))
    commitAll(root, 'kaut: add map doc')
    const { rows } = buildRefresh(root, repo, 'master', ['map/routes'])
    assert.equal(rows[0].status, REFRESH.MECHANICAL)
    assert.equal(rows[0].directive, 'kaut map')
})

test('refresh: section binding maps the changed file to its section', () => {
    const repo = makeGitRepo()
    const { root, sha } = makeStore(repo)
    writeRepoFile(repo, 'src/b.ts', 'export const b = 1\n')
    const base = commit(repo, 'add b')
    const doc = [
        '---', 'id: domains/sectioned', 'title: Sectioned', 'sources:', '    - file:src/a.ts',
        `derived_from_commit: ${base}`, 'harvested: 2026-08-25', 'engine: manual@0.3.0',
        'tickets: []', 'trust: T1', 'checks: []', 'schema_version: 1', '---', '',
        '## Alpha', '', 'alpha content', '',
        '## Beta', '<!-- sources: file:src/b.ts -->', '', 'beta content', '',
    ].join('\n')
    writeFileSync(path.join(root, 'domains/sectioned.md'), doc)
    commitAll(root, 'kaut: add sectioned doc')
    writeRepoFile(repo, 'src/b.ts', 'export const b = 2\n')
    commit(repo, 'change b')
    const { rows } = buildRefresh(root, repo, 'master', ['domains/sectioned'])
    const r = rows[0]
    assert.equal(r.status, REFRESH.DELTA)
    assert.deepEqual(r.sections, [{ heading: 'Beta', affected: ['src/b.ts'] }])
})

// ---------- draft / review (CLI, gate interplay) ----------

test('draft→review round trip: owner-gated layer refuses index but accepts a draft; review --approve lands with the audit tag', () => {
    const repo = makeGitRepo()
    const { root, sha } = makeStore(repo)
    const regDir = ownerGatedRegistry(root)
    const env = { KAUT_WORKSPACES_DIR: regDir }
    clearRegistryCache()

    // direct layer edit is refused by the synchronous gate (control)
    writeDoc(root, 'domains/demo.md', { sources: ['file:src/a.ts'], commit: sha, title: 'edited directly' })
    const refused = kaut(repo, root, ['index'], env)
    assert.equal(refused.code, 1)
    assert.match(refused.stdout, /write refused/)
    git(root, ['checkout', '--quiet', '--', 'domains/demo.md']) // restore

    // the SAME update as a draft sails through agent-tier
    writeDoc(root, path.join('.drafts', 'domains/demo.md'), { id: 'domains/demo', sources: ['file:src/a.ts'], commit: sha, title: 'updated via queue' })
    const queued = kaut(repo, root, ['draft', 'domains/demo'], env)
    assert.equal(queued.code, 0, queued.stdout)
    assert.match(queued.stdout, /draft queued: domains\/demo/)
    assert.equal(git(root, ['status', '--porcelain']), '') // committed, tamper-clean
    assert.ok(readJournal(root).some((r) => r.op === 'draft' && r.topic === 'domains/demo'))

    // queue visibility: review lists it; lookup notes it without serving it; doctor WARNs, still exit 0
    const list = kaut(repo, root, ['review'], env)
    assert.match(list.stdout, /update\s+domains\/demo/)
    const look = kaut(repo, root, ['lookup', 'domains/demo'], env)
    assert.match(look.stdout, /pending draft/)
    assert.doesNotMatch(look.stdout, /updated via queue/)
    const doc = kaut(repo, root, ['index'], env) // INDEX untouched by draft → no commit needed, exit 0
    assert.equal(doc.code, 0, doc.stdout)

    // owner lands the batch
    const approved = kaut(repo, root, ['review', '--approve', 'domains/demo'], env)
    assert.equal(approved.code, 0, approved.stdout)
    assert.match(readFileSync(path.join(root, 'domains/demo.md'), 'utf8'), /updated via queue/)
    assert.equal(existsSync(draftPath(root, 'domains/demo')), false)
    assert.match(git(root, ['log', '-1', '--format=%s']), /review-approve.*\[owner-approved: domains\/demo\]/)
    assert.equal(git(root, ['status', '--porcelain']), '')
})

test('draft door: wrong-repo and branch anchors are refused at the queue', () => {
    const repo = makeGitRepo()
    const { root } = makeStore(repo)
    // unknown commit → wrong-repo anchor
    writeDoc(root, path.join('.drafts', 'domains/demo.md'), { id: 'domains/demo', sources: ['file:src/a.ts'], commit: 'b'.repeat(40) })
    const wrong = kaut(repo, root, ['draft', 'domains/demo'])
    assert.equal(wrong.code, 1)
    assert.match(wrong.stdout, /not a commit of the anchor repo/)
    // branch commit → off-main
    git(repo, ['checkout', '--quiet', '-b', 'ticket'])
    writeRepoFile(repo, 'src/t.ts', 'x\n')
    const branchSha = commit(repo, 'branch work')
    git(repo, ['checkout', '--quiet', 'master'])
    writeDoc(root, path.join('.drafts', 'domains/demo.md'), { id: 'domains/demo', sources: ['file:src/a.ts'], commit: branchSha })
    const offMain = kaut(repo, root, ['draft', 'domains/demo'])
    assert.equal(offMain.code, 1)
    assert.match(offMain.stdout, /not on the main line/)
})

test('review --reject drops the draft and commits; doctor reports the pending queue as WARN only', () => {
    const repo = makeGitRepo()
    const { root, sha } = makeStore(repo)
    writeDoc(root, path.join('.drafts', 'decisions/new-rule.md'), { id: 'decisions/new-rule', sources: ['file:src/a.ts'], commit: sha })
    assert.equal(kaut(repo, root, ['draft', 'decisions/new-rule']).code, 0)
    kaut(repo, root, ['index']) // sync INDEX so doctor's only complaint is the queue
    const doc = kaut(repo, root, ['doctor'])
    assert.equal(doc.code, 0, doc.stdout) // WARN, never FAIL
    assert.match(doc.stdout, /drafts-pending — 1 draft\(s\) awaiting review: decisions\/new-rule/)
    const rejected = kaut(repo, root, ['review', '--reject', 'decisions/new-rule', '--note', 'not worth storing'])
    assert.equal(rejected.code, 0, rejected.stdout)
    assert.equal(listDrafts(root).length, 0)
    assert.match(git(root, ['log', '-1', '--format=%s']), /review-reject.*not worth storing/)
    assert.equal(existsSync(path.join(root, 'decisions/new-rule.md')), false) // never landed
})

// ---------- touched (change-site sensor) ----------

test('touched: names docs binding the edited files, section bindings included', () => {
    const repo = makeGitRepo()
    const { root, sha } = makeStore(repo)
    writeRepoFile(repo, 'src/b.ts', 'x\n')
    commit(repo, 'add b')
    const doc = [
        '---', 'id: decisions/beta-rule', 'title: Beta rule', 'sources:', '    - user:owner',
        `derived_from_commit: ${sha}`, 'harvested: 2026-08-25', 'engine: manual@0.3.0',
        'tickets: []', 'trust: T1', 'checks: []', 'schema_version: 1', '---', '',
        '## Rule', '<!-- sources: file:src/b.ts -->', '', 'rule text', '',
    ].join('\n')
    writeFileSync(path.join(root, 'decisions/beta-rule.md'), doc)
    commitAll(root, 'kaut: add section-bound doc')

    const hit = kaut(repo, root, ['touched', 'src/a.ts', 'src/b.ts'])
    assert.match(hit.stdout, /domains\/demo — src\/a\.ts/)
    assert.match(hit.stdout, /decisions\/beta-rule — src\/b\.ts/) // section-only binding matched
    const miss = kaut(repo, root, ['touched', 'src/unrelated.ts'])
    assert.match(miss.stdout, /no docs bind these files/)
})
