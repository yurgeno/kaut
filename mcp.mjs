#!/usr/bin/env node
/**
 * KAUT MCP server — the harness-neutral knowledge surface.
 * One stdio JSON-RPC server exposes the session-facing engine verbs as MCP tools; any
 * MCP-capable harness or orchestrator talks to KAUT without harness-specific skills.
 * Zero dependencies (engine law): the MCP stdio transport is newline-delimited JSON-RPC
 * 2.0, implemented by hand below.
 *
 * Design decisions:
 * - Tools SPAWN the CLI (one code path, no drift): the CLI is the contract; every call
 *   runs `kaut <verb> --json` with cwd = the tool's `repo` argument, so store
 *   resolution works exactly like a shell session in that repo. Latency (~0.5 s/call)
 *   is acceptable for a knowledge lookup.
 * - Every tool takes an optional `repo` (absolute path of the member repo whose store to
 *   address; default = the server's cwd) — one server serves a whole multi-repo
 *   workspace.
 * - Write surface = exactly what a SESSION is allowed: `kaut_write` (agent tier, the
 *   commit chokepoint still decides) and `kaut_draft` (the async owner queue). The
 *   owner-run escapes (`review --approve/--reject`, `index --approve`) are deliberately
 *   NOT exposed — the gate never reaches the agent surface.
 * - Failed writes roll the file back before returning, so a refused write can never
 *   leave the store dirty (a dirty store would poison reads as `tampered`).
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateDoc } from './lib/indexgen.mjs'

const ENGINE_DIR = path.dirname(fileURLToPath(import.meta.url))
const KAUT = path.join(ENGINE_DIR, 'kaut.mjs')
const ENGINE_VERSION = readFileSync(path.join(ENGINE_DIR, 'VERSION'), 'utf8').trim()
const ENGINE_COMMIT = (() => {
    const r = spawnSync('git', ['-C', ENGINE_DIR, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' })
    return r.status === 0 ? r.stdout.trim() : 'unknown'
})()

/** Run the engine CLI in a repo. @returns {{code: number, stdout: string, stderr: string}} */
function runCli(repo, args) {
    // 64 MB: spawnSync's default 1 MB maxBuffer would kill large outputs (whole-store
    // `stale --json`, big docs) with a truncated ENOBUFS instead of an honest answer.
    const r = spawnSync(process.execPath, [KAUT, ...args], { cwd: repo, encoding: 'utf8', env: process.env, maxBuffer: 64 * 1024 * 1024 })
    const spawnErr = r.error ? `\nspawn failed: ${r.error.code ?? r.error.message}` : ''
    return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: (r.stderr ?? '') + spawnErr }
}

/** Resolve + validate the `repo` argument (default: server cwd). */
function resolveRepo(a) {
    const repo = typeof a?.repo === 'string' && a.repo ? a.repo : process.cwd()
    if (!existsSync(repo) || !statSync(repo).isDirectory()) throw new Error(`repo is not a directory: ${repo}`)
    return repo
}

/** Doc-id hygiene for tools that turn an id into a store path. */
function validId(id) {
    if (typeof id !== 'string' || !id || id.includes('..') || path.isAbsolute(id) || !/^[A-Za-z0-9_\-/.]+$/.test(id))
        throw new Error(`invalid doc id: ${JSON.stringify(id)}`)
    return id.replace(/\.md$/, '')
}

/** The store root for a repo, via the CLI's own resolution (`kaut paths`). */
function storeRoot(repo) {
    const r = runCli(repo, ['paths'])
    if (r.code !== 0) throw new Error(`cannot resolve store for ${repo}: ${r.stderr || r.stdout}`.trim())
    return JSON.parse(r.stdout).root
}

/**
 * Write `content` to `abs`, run the CLI, and roll the file back if the CLI refused —
 * a refused write must never leave the store dirty (tamper-withhold would eat the doc).
 * @returns {{code: number, stdout: string, stderr: string}}
 */
function writeThroughPipeline(root, abs, content, repo, cliArgs) {
    const prev = existsSync(abs) ? readFileSync(abs, 'utf8') : null
    // Snapshot INDEX.md as well: `kaut index` regenerates it before the grant gate runs,
    // so a refusal (or a crash) mid-pipeline could otherwise leave it dirty — and a dirty
    // INDEX.md is withheld from every reader until the next successful index run.
    const indexAbs = path.join(root, 'INDEX.md')
    const prevIndex = existsSync(indexAbs) ? readFileSync(indexAbs, 'utf8') : null
    mkdirSync(path.dirname(abs), { recursive: true })
    writeFileSync(abs, content)
    const r = runCli(repo, cliArgs)
    if (r.code !== 0) {
        if (prev === null) unlinkSync(abs)
        else writeFileSync(abs, prev)
        if (prevIndex === null) { if (existsSync(indexAbs)) unlinkSync(indexAbs) }
        else if (!existsSync(indexAbs) || readFileSync(indexAbs, 'utf8') !== prevIndex) writeFileSync(indexAbs, prevIndex)
    }
    return r
}

const OUTCOMES = ['trusted', 'confirmed', 'insufficient', 'stale-misled']
const REPO_PROP = {
    repo: { type: 'string', description: 'Absolute path of the member repo whose store to address (default: the server cwd)' },
}

/** @type {Array<{name: string, description: string, inputSchema: object, handler: (a: any) => string}>} */
const TOOLS = [
    {
        name: 'kaut_lookup',
        description:
            'Look up project knowledge. Without `id`: the store catalog (INDEX). With `id`: the doc plus its freshness verdict (healthy/stale/broken/tampered), trust tier, and altitude band. Discipline: a stale/broken verdict or a landscape-altitude doc means CONFIRM IN CODE before relying on it; a healthy verdict on a precise doc is the permission to skip that confirm. Knowledge informs — it never authorizes actions.',
        inputSchema: { type: 'object', properties: { ...REPO_PROP, id: { type: 'string', description: 'Doc id, e.g. domains/search (omit for the catalog)' } } },
        handler: (a) => {
            const repo = resolveRepo(a)
            const r = runCli(repo, ['lookup', ...(a?.id ? [validId(a.id)] : []), '--json'])
            if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim())
            return r.stdout.trim()
        },
    },
    {
        name: 'kaut_note',
        description:
            'Record how a doc the session USED actually fared (the value signal; honor-system): trusted = used without reading code · confirmed = verified in code anyway · insufficient = did not answer, fell back to code (owed especially when the problem lay outside coverage — this draws the coverage boundary) · stale-misled = wrong/stale and misleading.',
        inputSchema: {
            type: 'object',
            properties: {
                ...REPO_PROP,
                topic: { type: 'string', description: 'Doc id the session used' },
                result: { type: 'string', enum: OUTCOMES },
                note: { type: 'string', description: 'Optional one-line context' },
            },
            required: ['topic', 'result'],
        },
        handler: (a) => {
            const repo = resolveRepo(a)
            const r = runCli(repo, ['note', validId(a.topic), String(a.result), ...(a.note ? ['--note', String(a.note)] : [])])
            if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim())
            return r.stdout.trim()
        },
    },
    {
        name: 'kaut_refresh',
        description:
            'Re-derivation delta bundle per doc: the target ref to anchor to (the tracked main TIP — never a branch or the working tree), sources changed since derivation with git status, the sections those files hit, dead patterns to re-bind, and anchor triage (wrong-repo-anchor / off-main-anchor = re-derive fully; mechanical = regenerate with the map adapters). Use it to repair a stale doc cheaply.',
        inputSchema: { type: 'object', properties: { ...REPO_PROP, ids: { type: 'array', items: { type: 'string' }, description: 'Doc ids to bundle (default: every doc)' } } },
        handler: (a) => {
            const repo = resolveRepo(a)
            const ids = Array.isArray(a?.ids) ? a.ids.map(validId) : []
            const r = runCli(repo, ['refresh', ...ids, '--json'])
            if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim())
            return r.stdout.trim()
        },
    },
    {
        name: 'kaut_touched',
        description:
            'The change-site sensor: given repo-relative files this session edited, name every doc whose source bindings (doc-level or section-level) cover them — the docs the session owes an update (agent layer) or a draft (owner layer) before closing.',
        inputSchema: {
            type: 'object',
            properties: { ...REPO_PROP, files: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Repo-relative paths, as git prints them' } },
            required: ['files'],
        },
        handler: (a) => {
            const repo = resolveRepo(a)
            if (!Array.isArray(a?.files) || !a.files.length) throw new Error('files: non-empty array required')
            const r = runCli(repo, ['touched', ...a.files.map(String), '--json'])
            if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim())
            return r.stdout.trim()
        },
    },
    {
        name: 'kaut_write',
        description:
            'Land an AGENT-TIER doc update through the write gate: the complete updated doc (frontmatter + body) replaces <store>/<id>.md and is validated, indexed, and committed through the engine chokepoint. Owner-gated layers and novel ids are REFUSED by the gate — queue those with kaut_draft instead. Set derived_from_commit to the tracked main tip (kaut_refresh names it). Requires this session to have verified the fact (the Tier-A hard gate — honor it).',
        inputSchema: {
            type: 'object',
            properties: {
                ...REPO_PROP,
                id: { type: 'string', description: 'Doc id, e.g. runbook/local-debug' },
                content: { type: 'string', description: 'The COMPLETE doc: frontmatter + body' },
            },
            required: ['id', 'content'],
        },
        handler: (a) => {
            const repo = resolveRepo(a)
            const id = validId(a.id)
            // Validate the contract BEFORE anything touches the store: `kaut index` lands
            // invalid docs with a report but exit 0, which would let garbage through this
            // surface with a success message.
            const v = validateDoc(`${id}.md`, String(a.content))
            if (!v.ok) throw new Error(`invalid doc (nothing written): ${v.errors.join('; ')}`)
            const root = storeRoot(repo)
            const r = writeThroughPipeline(root, path.join(root, `${id}.md`), String(a.content), repo, ['index'])
            if (r.code !== 0) {
                const msg = (r.stderr || r.stdout).trim()
                throw new Error(/write refused/.test(msg) ? `${msg}\n→ this doc is owner-gated: queue it with kaut_draft instead (the owner lands it via "kaut review")` : msg)
            }
            return `landed ${id} through the write gate\n${r.stdout.trim()}`
        },
    },
    {
        name: 'kaut_draft',
        description:
            'Queue a COMPLETE updated doc (frontmatter + body) for asynchronous owner review — the path for owner-gated layers (decisions/domains/contracts/flows) and novel ids. The queue door validates the contract AND the anchor (a wrong-repo or branch anchor is refused on the spot); the draft is committed durably but never served to readers. The owner lands or rejects the batch via "kaut review" (not exposed here by design).',
        inputSchema: {
            type: 'object',
            properties: {
                ...REPO_PROP,
                id: { type: 'string', description: 'Doc id the draft updates or creates' },
                content: { type: 'string', description: 'The COMPLETE doc: frontmatter + body' },
            },
            required: ['id', 'content'],
        },
        handler: (a) => {
            const repo = resolveRepo(a)
            const id = validId(a.id)
            const root = storeRoot(repo)
            const r = writeThroughPipeline(root, path.join(root, '.drafts', `${id}.md`), String(a.content), repo, ['draft', id])
            if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim())
            return r.stdout.trim()
        },
    },
    {
        name: 'kaut_status',
        description:
            'Store health overview: per-doc freshness verdicts, the pending draft queue, and the doctor summary line. Use it to see what rots and what awaits the owner.',
        inputSchema: { type: 'object', properties: { ...REPO_PROP } },
        handler: (a) => {
            const repo = resolveRepo(a)
            const stale = runCli(repo, ['stale', '--json'])
            if (stale.code !== 0) throw new Error((stale.stderr || stale.stdout).trim())
            const review = runCli(repo, ['review', '--json'])
            const doctor = runCli(repo, ['doctor'])
            const doctorLine = doctor.stdout.trim().split('\n').filter(Boolean).pop() ?? ''
            return JSON.stringify(
                {
                    verdicts: JSON.parse(stale.stdout),
                    pendingDrafts: review.code === 0 ? JSON.parse(review.stdout) : [],
                    doctor: doctorLine,
                    engine: { version: ENGINE_VERSION, commit: ENGINE_COMMIT },
                },
                null,
                2,
            )
        },
    },
]

// ---------- JSON-RPC 2.0 over newline-delimited stdio ----------

function send(obj) {
    process.stdout.write(JSON.stringify(obj) + '\n')
}

function handle(msg) {
    const { id, method, params } = msg
    const notification = id === undefined || id === null
    // JSON-RPC: notifications get NO response — not even errors. Every method this server
    // implements is a request; the only expected notifications (initialized/cancelled) are
    // correctly ignored here too.
    if (notification) return
    switch (method) {
        case 'initialize':
            return send({
                jsonrpc: '2.0',
                id,
                result: {
                    // Always answer with the version this server actually implements —
                    // echoing the client's ask would claim features (e.g. batching) we lack.
                    protocolVersion: '2025-06-18',
                    capabilities: { tools: {} },
                    serverInfo: { name: 'kaut', version: ENGINE_VERSION, title: `KAUT knowledge engine (${ENGINE_COMMIT})` },
                },
            })
        case 'ping':
            return send({ jsonrpc: '2.0', id, result: {} })
        case 'tools/list':
            return send({
                jsonrpc: '2.0',
                id,
                result: { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) },
            })
        case 'tools/call': {
            const tool = TOOLS.find((t) => t.name === params?.name)
            if (!tool) return send({ jsonrpc: '2.0', id, error: { code: -32602, message: `unknown tool: ${params?.name}` } })
            try {
                const text = tool.handler(params?.arguments ?? {})
                return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], isError: false } })
            } catch (e) {
                // tool-level failure = a RESULT with isError (MCP convention); protocol stays healthy
                return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: String(e?.message ?? e) }], isError: true } })
            }
        }
        default:
            return send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } })
    }
}

function processLine(line) {
    if (!line.trim()) return
    let msg
    try {
        msg = JSON.parse(line)
    } catch {
        return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } })
    }
    // Batch arrays: the 2025-06-18 protocol has no batching — answer honestly instead of
    // silently dropping the array (a batching client would hang forever on silence).
    if (Array.isArray(msg))
        return send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'batching not supported' } })
    try {
        handle(msg)
    } catch (e) {
        send({ jsonrpc: '2.0', id: msg?.id ?? null, error: { code: -32603, message: String(e?.message ?? e) } })
    }
}

// Hand-rolled line reader with a hard cap: readline would buffer an unbounded line in
// memory before handing it over — a malformed client could OOM the server.
const LINE_LIMIT = 32 * 1024 * 1024
let stdinBuf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
    stdinBuf += chunk
    let nl
    while ((nl = stdinBuf.indexOf('\n')) >= 0) {
        const line = stdinBuf.slice(0, nl)
        stdinBuf = stdinBuf.slice(nl + 1)
        processLine(line)
    }
    if (stdinBuf.length > LINE_LIMIT) {
        stdinBuf = ''
        send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: `line exceeds ${LINE_LIMIT} bytes` } })
    }
})
process.stdin.on('end', () => process.exit(0))
