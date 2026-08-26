/**
 * Write grants — the layered promotion gate enforced at the commit chokepoint (gitstore.commitAll).
 * Policy flows manifest → registry → resolveWritePolicy; enforcement is non-bypassable because every
 * write path funnels through commitAll. Open-until-configured: no writePolicy ⇒ free write.
 */
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { git, makeTmpDir, writeDoc } from './helpers.mjs'
import { commitAll, ensureStoreGit } from '../lib/gitstore.mjs'
import { clearRegistryCache, resolveWritePolicy } from '../lib/registry.mjs'
import { GrantError } from '../lib/grants.mjs'
import { readJournal } from '../lib/journal.mjs'

const PILOT = { runbook: 'agent', map: 'agent', '*': 'owner' }

/** A store with its own git + one ungated seed commit (raw git, before any registry exists). */
function freshStore() {
    const store = makeTmpDir()
    ensureStoreGit(store)
    writeFileSync(path.join(store, 'INDEX.md'), '# seed\n')
    git(store, ['add', '-A'])
    git(store, ['commit', '--quiet', '-m', 'seed'])
    return store
}

/** Point KAUT_WORKSPACES_DIR at a fresh registry describing one store (member or system). */
function setRegistry(storeRoot, { writePolicy = null, storePolicy = null, asSystem = false } = {}) {
    const dir = makeTmpDir()
    process.env.KAUT_WORKSPACES_DIR = dir
    const reg = asSystem
        ? { schema: 1, name: 't', systemStore: { id: 's', root: storeRoot, writePolicy } }
        : { schema: 1, name: 't', repos: [{ name: 'r', storeRoot, writePolicy, storePolicy }] }
    writeFileSync(path.join(dir, 't.json'), JSON.stringify(reg))
    clearRegistryCache()
}

/** A registry listing several member stores (roots[0] = the one we write to, the rest are siblings). */
function setMultiRegistry(roots, { writePolicy = null } = {}) {
    const dir = makeTmpDir()
    process.env.KAUT_WORKSPACES_DIR = dir
    const reg = {
        schema: 1,
        name: 't',
        repos: roots.map((storeRoot, i) => ({ name: `r${i}`, storeRoot, writePolicy, storePolicy: null })),
    }
    writeFileSync(path.join(dir, 't.json'), JSON.stringify(reg))
    clearRegistryCache()
}

/** Commit a doc into the store's HEAD via raw git — a PRE-EXISTING doc (setup, bypasses the gate). */
function seedDoc(store, rel) {
    writeDoc(store, rel)
    git(store, ['add', '-A'])
    git(store, ['commit', '--quiet', '-m', `seed ${rel}`])
}

/** Write a doc with an explicit `engine:` provenance (for map-by-provenance cases). */
function writeMapDoc(store, rel, provenance) {
    const id = rel.replace(/\.md$/, '')
    const lines = [
        '---', `id: ${id}`, 'type: map', 'title: M', 'sources:', '    - file:docker-compose.yml',
        `derived_from_commit: ${'a'.repeat(40)}`, 'harvested: 2026-06-18', `engine: ${provenance}`,
        'tickets: []', 'trust: T0', 'checks: []', 'schema_version: 1', '---', '', '## Pointers', '', 'x', '',
    ]
    mkdirSync(path.join(store, path.dirname(rel)), { recursive: true })
    writeFileSync(path.join(store, rel), lines.join('\n'))
}

test('resolveWritePolicy: layer/provenance table', () => {
    const e = { writePolicy: PILOT }
    assert.equal(resolveWritePolicy(e, 'runbook', 'manual@0'), 'agent')
    assert.equal(resolveWritePolicy(e, 'decisions', 'manual@0'), 'owner') // via '*'
    assert.equal(resolveWritePolicy(e, 'map', 'compose-map@0'), 'agent') // adapter map
    assert.equal(resolveWritePolicy(e, 'map', 'manual@0'), 'owner') // hand-authored map forced owner
    assert.equal(resolveWritePolicy({ writePolicy: null }, 'decisions', 'manual@0'), null) // open
    assert.equal(resolveWritePolicy({ writePolicy: { runbook: 'agent' } }, 'domains', 'manual@0'), null) // no '*' ⇒ free
})

test('agent-tier UPDATE commits cleanly without --approve + journals op:write tier:agent', () => {
    const store = freshStore()
    setRegistry(store, { writePolicy: PILOT })
    seedDoc(store, 'runbook/local-startup.md') // pre-existing → an update, not a novel create
    writeDoc(store, 'runbook/local-startup.md', { title: 'Updated' })
    assert.equal(commitAll(store, 'kaut: test'), true)
    const writes = readJournal(store).filter((r) => r.op === 'write')
    assert.equal(writes.length, 1)
    assert.equal(writes[0].topic, 'runbook/local-startup')
    assert.equal(writes[0].tier, 'agent')
})

test('owner-tier layer is REFUSED without --approve (nothing committed)', () => {
    const store = freshStore()
    setRegistry(store, { writePolicy: PILOT })
    writeDoc(store, 'decisions/why.md')
    assert.throws(() => commitAll(store, 'kaut: test'), (e) => e instanceof GrantError && e.refused[0].id === 'decisions/why')
    // nothing committed — HEAD is still only the seed commit
    assert.equal(git(store, ['log', '--format=%s']), 'seed')
})

test('owner-tier layer commits WITH --approve and records it in the commit message', () => {
    const store = freshStore()
    setRegistry(store, { writePolicy: PILOT })
    writeDoc(store, 'decisions/why.md')
    assert.equal(commitAll(store, 'kaut: test', { approve: true }), true)
    assert.ok(git(store, ['log', '-1', '--format=%s']).includes('[owner-approved: decisions/why]'))
})

test('map by provenance: adapter map commits (agent), hand-authored map refused', () => {
    const store = freshStore()
    setRegistry(store, { writePolicy: PILOT })
    // single store ⇒ map/services is a novel create, yet it commits: map is EXEMPT from the
    // creation-distinction (adapter map is deterministic/provenance-gated, §3).
    writeMapDoc(store, 'map/services.md', 'compose-map@0.3.0')
    assert.equal(commitAll(store, 'kaut: map'), true) // adapter ⇒ agent
    writeMapDoc(store, 'map/hand.md', 'manual@0.3.0')
    assert.throws(() => commitAll(store, 'kaut: map'), GrantError) // manual map ⇒ owner
})

test('do-not-touch refuses the ENTIRE commit, even an agent-tier doc', () => {
    const store = freshStore()
    setRegistry(store, { writePolicy: PILOT, storePolicy: 'do-not-touch' })
    writeDoc(store, 'runbook/x.md') // agent-tier, but the store is do-not-touch
    assert.throws(() => commitAll(store, 'kaut: test'), (e) => e instanceof GrantError && /do-not-touch/.test(e.message))
})

test('open-until-configured: a registry entry with no writePolicy commits owner-tier freely', () => {
    const store = freshStore()
    setRegistry(store, { writePolicy: null })
    writeDoc(store, 'decisions/why.md')
    assert.equal(commitAll(store, 'kaut: test'), true) // not governed ⇒ free
})

test('ungoverned: a store no registry knows commits any doc freely (byte-identical pre-gate)', () => {
    const store = freshStore()
    setRegistry(makeTmpDir(), { writePolicy: PILOT }) // registry exists but describes a DIFFERENT store
    writeDoc(store, 'decisions/why.md')
    assert.equal(commitAll(store, 'kaut: test'), true) // resolveWriteEntry null ⇒ free
})

test('system store resolves its own writePolicy (runbooks live there)', () => {
    const store = freshStore()
    setRegistry(store, { writePolicy: PILOT, asSystem: true })
    seedDoc(store, 'runbook/local-startup.md') // pre-existing → update path
    writeDoc(store, 'runbook/local-startup.md', { title: 'Updated' })
    assert.equal(commitAll(store, 'kaut: test'), true) // agent via systemStore.writePolicy
    writeDoc(store, 'decisions/why.md')
    assert.throws(() => commitAll(store, 'kaut: test'), GrantError) // owner-tier refused in the system store
})

test('creation-distinction: a NOVEL agent-tier id is REFUSED without --approve', () => {
    const store = freshStore()
    setRegistry(store, { writePolicy: PILOT }) // single store, no siblings ⇒ any new id is novel
    writeDoc(store, 'runbook/brand-new-procedure.md') // a type that exists nowhere in the deployment
    assert.throws(
        () => commitAll(store, 'kaut: test'),
        (e) => e instanceof GrantError && e.refused[0].id === 'runbook/brand-new-procedure' && e.refused[0].tier === 'owner',
    )
    assert.equal(git(store, ['log', '--format=%s']), 'seed') // nothing committed
})

test('creation-distinction: a novel agent-tier id lands WITH --approve (owner-approved)', () => {
    const store = freshStore()
    setRegistry(store, { writePolicy: PILOT })
    writeDoc(store, 'runbook/brand-new-procedure.md')
    assert.equal(commitAll(store, 'kaut: test', { approve: true }), true)
    assert.ok(git(store, ['log', '-1', '--format=%s']).includes('[owner-approved: runbook/brand-new-procedure]'))
    assert.equal(readJournal(store).filter((r) => r.op === 'write')[0].tier, 'owner-approved')
})

test('creation-distinction: creating a type that EXISTS in a sibling store is Tier A (agent)', () => {
    const sibling = freshStore()
    seedDoc(sibling, 'runbook/local-debug.md') // the canonical pattern is established here (committed)
    const store = freshStore()
    setMultiRegistry([store, sibling], { writePolicy: PILOT })
    writeDoc(store, 'runbook/local-debug.md') // first time in THIS store, but canonical in the deployment
    assert.equal(commitAll(store, 'kaut: test'), true) // no --approve needed
    assert.equal(readJournal(store).filter((r) => r.op === 'write')[0].tier, 'agent')
})
