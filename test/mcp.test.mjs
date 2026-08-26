/**
 * MCP server (mcp.mjs): protocol round-trip over newline-delimited JSON-RPC stdio against
 * real fixture repos/stores. Pins: the 7-tool surface, per-tool `repo` store resolution,
 * the write→gate interplay (agent-tier lands; owner-gated refused WITH rollback — the
 * store must stay clean), the draft queue round trip, and protocol error behavior.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { commitAll, ensureStoreGit, uncommittedPaths } from '../lib/gitstore.mjs'
import { commit, git, makeGitRepo, makeTmpDir, writeDoc, writeRepoFile } from './helpers.mjs'

const MCP = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'mcp.mjs')

/** Committed store fixture bound to the repo (mirrors refresh-drafts.test.mjs). */
function makeStore(repo) {
    const root = makeTmpDir()
    ensureStoreGit(root)
    writeFileSync(path.join(root, '.gitignore'), '.lock/\n*.tmp\njournal.jsonl\n.DS_Store\n')
    writeFileSync(path.join(root, 'kaut.config.json'), JSON.stringify({ schema: 1 }) + '\n')
    for (const dir of ['map', 'domains', 'decisions', 'runbook']) mkdirSync(path.join(root, dir), { recursive: true })
    writeRepoFile(repo, 'src/a.ts', 'export const a = 1\n')
    const sha = commit(repo, 'add source')
    writeDoc(root, 'domains/demo.md', { sources: ['file:src/a.ts'], commit: sha })
    commitAll(root, 'kaut: test fixture')
    return { root, sha }
}

/** A complete valid doc body for write/draft payloads. */
function docContent(id, sha, title) {
    return [
        '---', `id: ${id}`, `title: ${title}`, 'sources:', '    - file:src/a.ts',
        `derived_from_commit: ${sha}`, 'harvested: 2026-08-25', 'engine: manual@0.3.0',
        'tickets: []', 'trust: T1', 'checks: []', 'schema_version: 1', '---', '',
        '## Pointers', '', `${title} content`, '',
    ].join('\n')
}

/**
 * Spawn the server, send the standard handshake + the given requests, collect responses
 * until every id is answered, then close.
 * @param {string} cwd server cwd
 * @param {object[]} requests JSON-RPC requests (with ids)
 * @param {Record<string, string>} [extraEnv]
 * @returns {Promise<Map<number, any>>} id → response
 */
function roundTrip(cwd, requests, extraEnv = {}) {
    return new Promise((resolve, reject) => {
        // KAUT_HOME → tmp: even a test that forgets KAUT_ROOT can never derive a store
        // into the REAL ~/.kaut (this bit us once — fixture-derived litter dirs).
        const child = spawn(process.execPath, [MCP], { cwd, env: { ...process.env, KAUT_HOME: makeTmpDir(), ...extraEnv } })
        const want = new Set(requests.map((r) => r.id))
        const got = new Map()
        let buf = ''
        const timer = setTimeout(() => {
            child.kill()
            reject(new Error(`mcp timeout — answered: [${[...got.keys()]}] of [${[...want]}]`))
        }, 30000)
        child.stdout.on('data', (d) => {
            buf += d
            let nl
            while ((nl = buf.indexOf('\n')) >= 0) {
                const line = buf.slice(0, nl)
                buf = buf.slice(nl + 1)
                if (!line.trim()) continue
                const msg = JSON.parse(line)
                if (msg.id !== undefined && msg.id !== null) got.set(msg.id, msg)
            }
            if ([...want].every((id) => got.has(id))) {
                clearTimeout(timer)
                child.kill()
                resolve(got)
            }
        })
        child.on('error', (e) => {
            clearTimeout(timer)
            reject(e)
        })
        child.stdin.write(
            [
                JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } } }),
                JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
                ...requests.map((r) => JSON.stringify(r)),
                '',
            ].join('\n'),
        )
    })
}

const call = (id, name, args = {}) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })
const text = (resp) => resp.result.content[0].text

test('handshake + tools/list exposes the 7-tool surface; owner verbs absent', async () => {
    const repo = makeGitRepo()
    makeStore(repo)
    const got = await roundTrip(repo, [{ jsonrpc: '2.0', id: 1, method: 'tools/list' }])
    const names = got.get(1).result.tools.map((t) => t.name).sort()
    assert.deepEqual(names, ['kaut_draft', 'kaut_lookup', 'kaut_note', 'kaut_refresh', 'kaut_status', 'kaut_touched', 'kaut_write'])
    assert.ok(!names.some((n) => /review|approve/.test(n)))
})

test('lookup: catalog and healthy doc, via the repo parameter from a foreign cwd', async () => {
    const repo = makeGitRepo()
    const { root } = makeStore(repo)
    const elsewhere = makeTmpDir() // server cwd is NOT the repo — repo param must carry
    const got = await roundTrip(
        elsewhere,
        [call(1, 'kaut_lookup', { repo }), call(2, 'kaut_lookup', { repo, id: 'domains/demo' })],
        { KAUT_ROOT: root },
    )
    assert.equal(JSON.parse(text(got.get(1))).mode, 'catalog')
    const doc = JSON.parse(text(got.get(2)))
    assert.equal(doc.verdict, 'healthy')
    assert.equal(doc.id, 'domains/demo')
})

test('write: agent-tier lands through the pipeline; store stays clean; lookup serves the update', async () => {
    const repo = makeGitRepo()
    const { root, sha } = makeStore(repo)
    const got = await roundTrip(repo, [
        call(1, 'kaut_write', { id: 'runbook/steps', content: docContent('runbook/steps', sha, 'Steps') }),
        call(2, 'kaut_lookup', { id: 'runbook/steps' }),
    ], { KAUT_ROOT: root })
    assert.equal(got.get(1).result.isError, false, text(got.get(1)))
    assert.match(text(got.get(1)), /landed runbook\/steps/)
    assert.equal(JSON.parse(text(got.get(2))).verdict, 'healthy')
    assert.equal(uncommittedPaths(root).size, 0)
})

test('write: owner-gated layer is refused, ROLLED BACK, and routed to kaut_draft; the draft then queues', async () => {
    const repo = makeGitRepo()
    const { root, sha } = makeStore(repo)
    const regDir = makeTmpDir()
    writeFileSync(
        path.join(regDir, 't.json'),
        JSON.stringify({ schema: 1, name: 't', repos: [{ name: 'r', storeRoot: root, writePolicy: { '*': 'owner' } }] }),
    )
    const env = { KAUT_WORKSPACES_DIR: regDir, KAUT_ROOT: root }
    const updated = docContent('domains/demo', sha, 'Updated demo')
    const got = await roundTrip(repo, [
        call(1, 'kaut_write', { id: 'domains/demo', content: updated }),
        call(2, 'kaut_draft', { id: 'domains/demo', content: updated }),
        call(3, 'kaut_status', {}),
    ], env)
    // refused + hint + rollback (the store must be clean, original content intact)
    assert.equal(got.get(1).result.isError, true)
    assert.match(text(got.get(1)), /write refused/)
    assert.match(text(got.get(1)), /kaut_draft/)
    assert.equal(uncommittedPaths(root).size, 0)
    assert.doesNotMatch(git(root, ['show', 'HEAD:domains/demo.md']), /Updated demo/)
    // the same update queues as a draft
    assert.equal(got.get(2).result.isError, false, text(got.get(2)))
    assert.match(text(got.get(2)), /draft queued: domains\/demo/)
    assert.equal(uncommittedPaths(root).size, 0)
    // status shows the pending draft + verdicts + doctor line
    const status = JSON.parse(text(got.get(3)))
    assert.deepEqual(status.pendingDrafts, [{ id: 'domains/demo', kind: 'update' }])
    assert.ok(Array.isArray(status.verdicts))
    assert.ok(status.engine.version)
})

test('draft: an invalid draft is refused and rolled back (no dirty store)', async () => {
    const repo = makeGitRepo()
    const { root } = makeStore(repo)
    const got = await roundTrip(repo, [call(1, 'kaut_draft', { id: 'domains/demo', content: 'not a doc at all' })], { KAUT_ROOT: root })
    assert.equal(got.get(1).result.isError, true)
    assert.equal(uncommittedPaths(root).size, 0)
})

test('touched + note + refresh round-trip', async () => {
    const repo = makeGitRepo()
    const { root, sha } = makeStore(repo)
    writeRepoFile(repo, 'src/a.ts', 'export const a = 2\n')
    commit(repo, 'change source')
    const got = await roundTrip(repo, [
        call(1, 'kaut_touched', { files: ['src/a.ts', 'src/other.ts'] }),
        call(2, 'kaut_note', { topic: 'domains/demo', result: 'confirmed', note: 'mcp test' }),
        call(3, 'kaut_refresh', { ids: ['domains/demo'] }),
    ], { KAUT_ROOT: root })
    assert.deepEqual(JSON.parse(text(got.get(1))), [{ id: 'domains/demo', matched: ['src/a.ts'] }])
    assert.match(text(got.get(2)), /noted: domains\/demo → confirmed/)
    const bundle = JSON.parse(text(got.get(3)))
    assert.equal(bundle.rows[0].status, 'delta')
    assert.equal(bundle.rows[0].changed[0].path, 'src/a.ts')
    void sha
})

test('write: a NOVEL owner-gated id is refused with INDEX.md fully rolled back (store clean)', async () => {
    const repo = makeGitRepo()
    const { root, sha } = makeStore(repo)
    // commit a baseline INDEX.md while the gate is still open (no registry)
    execFileSync('node', [path.join(path.dirname(MCP), 'kaut.mjs'), 'index'], { cwd: repo, encoding: 'utf8', env: { ...process.env, KAUT_ROOT: root } })
    const regDir = makeTmpDir()
    writeFileSync(
        path.join(regDir, 't.json'),
        JSON.stringify({ schema: 1, name: 't', repos: [{ name: 'r', storeRoot: root, writePolicy: { '*': 'owner' } }] }),
    )
    const before = git(root, ['show', 'HEAD:INDEX.md'])
    const got = await roundTrip(repo, [
        call(1, 'kaut_write', { id: 'decisions/evil', content: docContent('decisions/evil', sha, 'Injected row') }),
        call(2, 'kaut_lookup', {}),
    ], { KAUT_WORKSPACES_DIR: regDir, KAUT_ROOT: root })
    assert.equal(got.get(1).result.isError, true)
    // the refusal must leave NOTHING behind: no doc, no dirty INDEX.md, no catalog row
    assert.equal(uncommittedPaths(root).size, 0)
    assert.equal(git(root, ['show', 'HEAD:INDEX.md']), before)
    assert.doesNotMatch(text(got.get(2)), /Injected row/)
})

test('write: contract-invalid content is refused before anything touches the store', async () => {
    const repo = makeGitRepo()
    const { root } = makeStore(repo)
    const head = git(root, ['rev-parse', 'HEAD'])
    const got = await roundTrip(repo, [call(1, 'kaut_write', { id: 'runbook/garbage', content: 'not a doc' })], { KAUT_ROOT: root })
    assert.equal(got.get(1).result.isError, true)
    assert.match(text(got.get(1)), /invalid doc/)
    assert.equal(uncommittedPaths(root).size, 0)
    assert.equal(git(root, ['rev-parse', 'HEAD']), head)
})

test('initialize answers with the version this server implements, not an echo', async () => {
    const repo = makeGitRepo()
    makeStore(repo)
    // roundTrip's handshake asks for 2025-06-18; ask for an older one explicitly here
    const got = await roundTrip(repo, [{ jsonrpc: '2.0', id: 7, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } } }])
    assert.equal(got.get(7).result.protocolVersion, '2025-06-18')
    assert.equal(got.get(0).result.protocolVersion, '2025-06-18')
})

test('protocol errors: unknown tool → isError result; unknown method → -32601; bad id → isError', async () => {
    const repo = makeGitRepo()
    makeStore(repo)
    const got = await roundTrip(repo, [
        call(1, 'kaut_nope'),
        { jsonrpc: '2.0', id: 2, method: 'no/such' },
        call(3, 'kaut_lookup', { id: '../escape' }),
    ])
    assert.equal(got.get(1).error.code, -32602)
    assert.equal(got.get(2).error.code, -32601)
    assert.equal(got.get(3).result.isError, true)
    assert.match(text(got.get(3)), /invalid doc id/)
})
