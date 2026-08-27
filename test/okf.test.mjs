/**
 * OKF (Open Knowledge Format) conformance — the additive `type` key (vector B7-α) and the
 * v0.2 bundle surface (`kaut okf check|stamp|export`).
 * `type` == the doc's layer; optional in frontmatter on READ (back-derived from the id when
 * absent), consistency-checked when present, injected at the serialization chokepoint so
 * every engine-written doc physically carries it, backfillable on legacy docs via `stamp`
 * (through the write gate), and projected by `export` into a standalone conformant bundle.
 * Contract: SCHEMA §22–23.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { serializeFrontmatter } from '../lib/frontmatter.mjs'
import { typeForId, validateDoc } from '../lib/indexgen.mjs'
import { renderServicesDoc } from '../lib/composemap.mjs'
import { commitAll, ensureStoreGit } from '../lib/gitstore.mjs'
import { clearRegistryCache } from '../lib/registry.mjs'
import { commit, git, makeGitRepo, makeTmpDir, writeDoc, writeRepoFile } from './helpers.mjs'

const KAUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'kaut.mjs')

/** Committed store fixture with one legacy (type-less) doc bound to src/a.ts at the repo HEAD. */
function makeStore(repo) {
    const root = makeTmpDir()
    ensureStoreGit(root)
    writeFileSync(path.join(root, '.gitignore'), '.lock/\n*.tmp\njournal.jsonl\n.DS_Store\n')
    writeFileSync(path.join(root, 'kaut.config.json'), JSON.stringify({ schema: 1 }) + '\n')
    for (const dir of ['map', 'domains', 'decisions']) mkdirSync(path.join(root, dir), { recursive: true })
    writeRepoFile(repo, 'src/a.ts', 'export const a = 1\n')
    const sha = commit(repo, 'add source')
    writeDoc(root, 'domains/demo.md', { sources: ['file:src/a.ts'], commit: sha }) // writeDoc emits NO type: — a legacy doc
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

/** A registry dir owner-gating every layer of `storeRoot`. */
function ownerGatedRegistry(storeRoot) {
    const dir = makeTmpDir()
    writeFileSync(
        path.join(dir, 't.json'),
        JSON.stringify({ schema: 1, name: 't', repos: [{ name: 'r', storeRoot, writePolicy: { '*': 'owner' } }] }),
    )
    return dir
}

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

// ---------- serialization-chokepoint injection ----------

test('serializeFrontmatter: id without type → the layer is injected right after id', () => {
    const out = serializeFrontmatter({ id: 'domains/x', title: 'T' }, 'body')
    const lines = out.split('\n')
    assert.equal(lines[1], 'id: domains/x')
    assert.equal(lines[2], 'type: domains')
})

test('serializeFrontmatter: an explicit matching type is untouched (no duplicate, same slot)', () => {
    const out = serializeFrontmatter({ id: 'domains/x', type: 'domains', title: 'T' }, 'body')
    assert.equal(out.split('\n').filter((l) => l.startsWith('type:')).length, 1)
    assert.equal(out.split('\n')[2], 'type: domains')
})

// ---------- okf check / stamp (CLI, gate interplay) ----------

test('okf check: a legacy type-less doc fails conformance; stamp backfills through the pipeline; second stamp is a no-op; check then passes', () => {
    const repo = makeGitRepo()
    const { root } = makeStore(repo)

    const before = kaut(repo, root, ['okf', 'check'])
    assert.equal(before.code, 1)
    assert.match(before.stdout, /1 concept docs, 1 missing type, 0 invalid/)
    assert.match(before.stdout, /missing type: domains\/demo/)

    const stamped = kaut(repo, root, ['okf', 'stamp'])
    assert.equal(stamped.code, 0, stamped.stdout)
    assert.match(stamped.stdout, /type backfilled on 1 doc\(s\): domains\/demo/)
    const doc = readFileSync(path.join(root, 'domains/demo.md'), 'utf8')
    assert.match(doc, /^id: domains\/demo\ntype: domains$/m) // physically stamped, right after id
    assert.match(doc, /## Pointers/) // body survived the round trip
    assert.equal(git(root, ['status', '--porcelain']), '') // committed through the chokepoint

    const again = kaut(repo, root, ['okf', 'stamp'])
    assert.equal(again.code, 0)
    assert.match(again.stdout, /nothing to stamp/)

    const after = kaut(repo, root, ['okf', 'check'])
    assert.equal(after.code, 0, after.stdout)
    assert.match(after.stdout, /1 concept docs, 0 missing type, 0 invalid/)
    assert.match(after.stdout, /conformant \(okf 0\.2\)/)
})

test('okf stamp: an owner-gated layer refuses without --approve and the refusal leaves the store byte-clean', () => {
    const repo = makeGitRepo()
    const { root } = makeStore(repo)
    const env = { KAUT_WORKSPACES_DIR: ownerGatedRegistry(root) }
    clearRegistryCache()

    const refused = kaut(repo, root, ['okf', 'stamp'], env)
    assert.equal(refused.code, 1)
    assert.match(refused.stdout, /write refused — owner-gated docs need --approve: domains\/demo/)
    assert.equal(git(root, ['status', '--porcelain']), '') // pre-flight ran BEFORE any rewrite
    assert.doesNotMatch(readFileSync(path.join(root, 'domains/demo.md'), 'utf8'), /^type:/m)

    const approved = kaut(repo, root, ['okf', 'stamp', '--approve'], env)
    assert.equal(approved.code, 0, approved.stdout)
    assert.match(git(root, ['log', '-1', '--format=%s']), /okf-stamp.*\[owner-approved: domains\/demo\]/)
})

// ---------- okf export ----------

/** Fixture with a second, owner-approved doc; returns the export dir. */
function exportedBundle() {
    const repo = makeGitRepo()
    const { root, sha } = makeStore(repo)
    writeDoc(root, 'decisions/beta-rule.md', { sources: ['file:src/a.ts', 'user:owner'], commit: sha, title: 'Beta rule' })
    git(root, ['add', '-A'])
    git(root, ['commit', '--quiet', '-m', 'kaut: review-approve (decisions/beta-rule) [owner-approved: decisions/beta-rule]'])
    const out = path.join(makeTmpDir(), 'bundle')
    const res = kaut(repo, root, ['okf', 'export', '--out', out])
    return { repo, root, out, res }
}

test('okf export: every non-reserved .md in the bundle carries frontmatter with a non-empty type; index.md pins okf_version 0.2', () => {
    const { res, out } = exportedBundle()
    assert.equal(res.code, 0, res.stdout)
    assert.match(res.stdout, /okf export: 2 concepts -> .*bundle \(okf 0\.2\)/)

    const mds = []
    const walk = (dir) =>
        readdirSync(dir, { withFileTypes: true }).forEach((e) =>
            e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith('.md') && mds.push(path.join(dir, e.name)),
        )
    walk(out)
    assert.equal(mds.length, 4) // 2 concepts + index.md + log.md
    for (const f of mds) {
        const base = path.basename(f)
        if (base === 'log.md') continue // reserved: history, no frontmatter required
        const raw = readFileSync(f, 'utf8')
        assert.match(raw, /^---\n[\s\S]+?\n---\n/, `${base} has a frontmatter block`)
        if (base === 'index.md') assert.match(raw, /^okf_version: "0\.2"$/m)
        else assert.match(raw, /^type: \S+$/m, `${base} carries a non-empty type`)
    }
    assert.match(readFileSync(path.join(out, 'index.md'), 'utf8'), /# .* — OKF bundle[\s\S]*## decisions\n\n\* \[Beta rule\]\(\/decisions\/beta-rule\.md\)/)
    assert.match(readFileSync(path.join(out, 'log.md'), 'utf8'), /^# Log\n\n## \d{4}-\d{2}-\d{2}\n\n\* \*\*Update\*\* /)
})

test('okf export: OKF frontmatter shape — resource-mapping sources, generated block, verified only on owner-approved docs, extensions + body verbatim', () => {
    const { out } = exportedBundle()
    const approvedDoc = readFileSync(path.join(out, 'decisions/beta-rule.md'), 'utf8')
    assert.match(approvedDoc, /^sources:\n  - resource: "file:src\/a\.ts"\n  - resource: "user:owner"$/m)
    assert.match(approvedDoc, /^generated:\n  by: manual\/0\.1\.0\n  at: "\d{4}-\d{2}-\d{2}T/m) // engine @ → /; datetime YAML-quoted
    // store commits are authored under the engine identity; the exporter resolves the PERSON
    // behind the approval (global git user.name), so "human:KAUT" must never appear
    assert.match(approvedDoc, /^verified:\n  - by: "human:[^"]+"\n    at: "\d{4}-\d{2}-\d{2}T/m)
    assert.ok(!approvedDoc.includes('human:KAUT'))
    assert.match(approvedDoc, /^id: decisions\/beta-rule$/m) // native fields ride as extensions
    assert.match(approvedDoc, /^derived_from_commit: [0-9a-f]{40}$/m)
    assert.match(approvedDoc, /^trust: T1$/m)
    assert.match(approvedDoc, /^tickets: \[\]$/m)
    assert.match(approvedDoc, /\n---\n\n## Pointers\n\ncontent\n$/) // body verbatim
    assert.match(approvedDoc, /^description: content$/m) // first meaningful body line

    const plainDoc = readFileSync(path.join(out, 'domains/demo.md'), 'utf8')
    assert.doesNotMatch(plainDoc, /^verified:/m) // honest unverified tier — key omitted
})

test('okf export: refuses a non-empty target without --force and a target inside the store', () => {
    const { repo, root, out } = exportedBundle()
    const rerun = kaut(repo, root, ['okf', 'export', '--out', out])
    assert.equal(rerun.code, 1)
    assert.match(rerun.stdout, /not empty.*--force/)
    const forced = kaut(repo, root, ['okf', 'export', '--out', out, '--force'])
    assert.equal(forced.code, 0, forced.stdout)
    const inside = kaut(repo, root, ['okf', 'export', '--out', path.join(root, 'bundle')])
    assert.equal(inside.code, 1)
    assert.match(inside.stdout, /outside the store/)
})
