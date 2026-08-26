#!/usr/bin/env node
/**
 * KAUT engine CLI.
 *
 *   node kaut.mjs <command> [flags]
 *     bootstrap   create/repair the store skeleton for the current repo (idempotent)
 *     index       regenerate INDEX.md (under lock; auto-commit when changed)
 *     doctor      validate store integrity; exit 0 = healthy
 *     stale       freshness verdicts per doc (read-only)
 *     lookup      serve one doc (or the catalog) with verdict/trust/altitude
 *     note        record an in-session outcome for a doc the session used
 *     refresh     per-doc re-derivation delta bundles
 *     draft       queue a doc update for asynchronous owner review
 *     review      owner side of the draft queue (list/diff/--approve/--reject)
 *     touched     which docs bind the given changed files (change-site sensor)
 *     digest      aggregate journal telemetry across workspace stores
 *     map         regenerate the L0 maps (adapter collectors)
 *     workspace   init/list multi-repo workspaces from a conductor manifest
 *     paths       print resolved {projectId, root, engine, repo, mainBranch, source}
 *
 * Exit codes: 0 ok · 1 validation/doctor failure · 2 lock busy · 3 environment missing.
 */
import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { CONFIG_NAME, deriveProjectId, discover, EnvironmentError, kautHome, resolveFreshnessRepo, storeConfigPath, tryGit } from './lib/discover.mjs'
import { commitAll, ensureStoreGit, storeGit, uncommittedPaths } from './lib/gitstore.mjs'
import { enforceGrants } from './lib/grants.mjs'
import { generateIndex, LAYER_DIRS, scanStore, typeForId, validateDoc, writeIndex } from './lib/indexgen.mjs'
import { acquireLock, LockBusyError } from './lib/lock.mjs'
import { FILE_TYPES, parseSources } from './lib/sources.mjs'
import { parseSections } from './lib/sections.mjs'
import { filterMatch } from './lib/glob.mjs'
import { parseFrontmatter } from './lib/frontmatter.mjs'
import { createContext, resolveAnchor, staleAll, verdictForDoc, VERDICT } from './lib/stale.mjs'
import { buildRefresh, REFRESH } from './lib/refresh.mjs'
import { draftPath, listDrafts, promoteDraft, removeDraft } from './lib/drafts.mjs'
import { altitudeFor } from './lib/altitude.mjs'
import { nearestDocs, renderLookup, renderMiss, renderTampered } from './lib/lookup.mjs'
import { appendJournal, readJournal } from './lib/journal.mjs'
import { aggregate, renderDigest } from './lib/digest.mjs'
import { buildRouteMap, RouteMapError } from './lib/routemap.mjs'
import { buildPackageGraph } from './lib/pkggraph.mjs'
import { buildComposeMap, ComposeMapError } from './lib/composemap.mjs'
import {
    ensureExcludeEntries,
    listWorkspaces,
    loadManifest,
    neutralConfig,
    planWorkspace,
    systemConfig,
    workspacePointerText,
    WorkspaceError,
    writeRegistry,
} from './lib/workspace.mjs'

const ENGINE_DIR = path.dirname(fileURLToPath(import.meta.url))
const ENGINE_VERSION = readFileSync(path.join(ENGINE_DIR, 'VERSION'), 'utf8').trim()

// journal.jsonl is untracked telemetry, never knowledge — keep it out of git.
const STORE_GITIGNORE = '.lock/\n*.tmp\njournal.jsonl\n.DS_Store\n'
const STORE_DIRS = ['map', 'domains', 'decisions']
const POINTER_NAME = '.kaut.json'

/** Validation error mapped to exit code 1. */
class ValidationError extends Error {
    /** @param {string} message */
    constructor(message) {
        super(message)
        this.code = 'KAUT_VALIDATION'
    }
}

/**
 * Doc-id hygiene at the engine boundary (mirrors mcp.mjs validId): ids become store paths,
 * so confinement must hold even for direct CLI callers and future wrappers — not only MCP.
 * @param {string} id
 * @returns {string} the id without a trailing .md
 */
function assertDocId(id) {
    if (typeof id !== 'string' || !id || id.includes('..') || path.isAbsolute(id) || !/^[A-Za-z0-9_\-/.]+$/.test(id))
        throw new ValidationError(`invalid doc id: ${JSON.stringify(id)}`)
    return id.replace(/\.md$/, '')
}

/**
 * Initial per-project config (SCHEMA §5). Bootstrap writes it once and never
 * overwrites an existing config. There is deliberately no `knowledge.root` key — the root
 * is resolved by the discovery chain, never by the config that lives inside it.
 *
 * v0.3.0 hardening (engine-vs-data principle: "the engine never
 * contains project knowledge"): the seed carries STACK-conventional defaults only (the
 * Vue/Nx map globs the built-in adapters target); everything project-specific — ticket
 * pattern, tracker MCP, runtime commands, source globs with project file names — starts
 * EMPTY and is edited into the config (data) per project. Existing configs are never
 * rewritten, so pre-0.3.0 stores keep their values.
 * @param {{projectId: string, repo: string, mainBranch: string}} d
 * @returns {object}
 */
function buildConfig(d) {
    return {
        schema: 1,
        project: {
            id: d.projectId,
            repo: d.repo,
            remote: tryGit(['remote', 'get-url', 'origin'], d.repo) ?? null,
            mainBranch: d.mainBranch,
        },
        assurance: { level: 2 },
        language: 'en',
        map: {
            routes: ['src/router/routes.ts'],
            stores: ['packages/*/src/stores/**'],
            packages: ['packages/*'],
        },
        sources: {},
        runtime: {},
        tickets: { pattern: null, mcp: null, readOnly: true },
        collectors: { default: ['codebase', 'user-input'], onDemand: [] },
        trust: {
            sourceOverrides: {},
            categoryFloors: { map: 'T0', flows: 'T1', domains: 'T3', decisions: 'T3' },
        },
    }
}

/**
 * Regenerate INDEX.md. Writes only when content actually changed (keeps re-runs diff-free).
 * Caller must hold the store lock.
 * @param {string} root
 * @param {string} projectId
 * @returns {{changed: boolean, docs: number, invalid: Array<{path: string, errors: string[]}>}}
 */
function runIndex(root, projectId) {
    const { content, docs, invalid } = generateIndex(root, projectId)
    const indexPath = path.join(root, 'INDEX.md')
    const old = existsSync(indexPath) ? readFileSync(indexPath, 'utf8') : null
    const changed = old !== content
    if (changed) writeIndex(root, content)
    return { changed, docs: docs.length, invalid }
}

/**
 * `kaut bootstrap` — ordered idempotent steps. Each step:
 * check → create only if absent → record `created|exists`. Never overwrites existing data.
 * @param {ReturnType<typeof discover>} d
 * @param {{dryRun: boolean, log: (s: string) => void, approve?: boolean}} opts
 */
async function cmdBootstrap(d, { dryRun, log, approve = false }) {
    /** @type {Array<[string, string]>} */
    const actions = []
    /**
     * @param {string} name step label
     * @param {boolean} exists current-state probe result
     * @param {() => void} create effect (skipped on dry-run / when exists)
     */
    const step = (name, exists, create) => {
        if (exists) actions.push([name, 'exists'])
        else if (dryRun) actions.push([name, 'would create'])
        else {
            create()
            actions.push([name, 'created'])
        }
    }

    step('store root', existsSync(d.root), () => mkdirSync(d.root, { recursive: true }))
    if (dryRun && !existsSync(d.root)) {
        // Nothing on disk yet — every remaining step would create; report and stop.
        for (const name of ['store git', '.gitignore', 'config', 'layer dirs', 'obligations.jsonl', 'INDEX.md', 'pointer', 'exclude entry'])
            actions.push([name, 'would create'])
        printBootstrapSummary(d, actions, log)
        return
    }

    const release = dryRun ? () => {} : await acquireLock(d.root, 'bootstrap')
    try {
        step('store git', existsSync(path.join(d.root, '.git')), () => ensureStoreGit(d.root))
        if (!dryRun) ensureStoreGit(d.root) // converge identity/config even when repo exists

        step('store .gitignore', existsSync(path.join(d.root, '.gitignore')), () =>
            writeFileSync(path.join(d.root, '.gitignore'), STORE_GITIGNORE),
        )
        step(CONFIG_NAME, existsSync(storeConfigPath(d.root)), () =>
            writeFileSync(
                path.join(d.root, CONFIG_NAME),
                JSON.stringify(buildConfig(d), null, 4) + '\n',
            ),
        )
        for (const dir of STORE_DIRS)
            step(`${dir}/`, existsSync(path.join(d.root, dir)), () =>
                mkdirSync(path.join(d.root, dir), { recursive: true }),
            )
        step('obligations.jsonl', existsSync(path.join(d.root, 'obligations.jsonl')), () =>
            writeFileSync(path.join(d.root, 'obligations.jsonl'), ''),
        )

        if (!dryRun) {
            const idx = runIndex(d.root, d.projectId)
            actions.push(['INDEX.md', idx.changed ? 'created' : 'exists'])
        } else actions.push(['INDEX.md', 'would generate'])

        // Pointer + local ignore entry in the PROJECT repo (D3): `.git/info/exclude`, never
        // the committed .gitignore — the team repo stays byte-identical.
        const pointerPath = path.join(d.repo, POINTER_NAME)
        step('pointer .kaut.json', existsSync(pointerPath), () =>
            writeFileSync(
                pointerPath,
                JSON.stringify(
                    { schema: 1, projectId: d.projectId, root: d.root, engine: d.engine },
                    null,
                    4,
                ) + '\n',
            ),
        )
        const commonDir = tryGit(['rev-parse', '--path-format=absolute', '--git-common-dir'], d.repo)
        if (!commonDir) throw new EnvironmentError(`cannot resolve git common dir for ${d.repo}`)
        const excludeFile = path.join(commonDir, 'info', 'exclude')
        const excludeHas =
            existsSync(excludeFile) &&
            readFileSync(excludeFile, 'utf8').split('\n').includes(POINTER_NAME)
        step('exclude entry', excludeHas, () => {
            mkdirSync(path.dirname(excludeFile), { recursive: true })
            appendFileSync(excludeFile, `${POINTER_NAME}\n`)
        })

        if (!dryRun) {
            const committed = commitAll(d.root, `kaut: bootstrap v${ENGINE_VERSION}`, { approve })
            actions.push(['store commit', committed ? 'created' : 'exists'])
        }
    } finally {
        release()
    }
    printBootstrapSummary(d, actions, log)
}

/**
 * @param {ReturnType<typeof discover>} d
 * @param {Array<[string, string]>} actions
 * @param {(s: string) => void} log
 */
function printBootstrapSummary(d, actions, log) {
    for (const [name, status] of actions) log(`${status.padEnd(12)} ${name}`)
    const created = actions.filter(([, s]) => s === 'created').length
    log(`bootstrap: ${created} created, ${actions.length - created} already in place`)
    log(`store: ${d.root}`)
}

/**
 * `kaut index`.
 * @param {ReturnType<typeof discover>} d
 * @param {{dryRun: boolean, log: (s: string) => void, approve?: boolean}} opts
 */
async function cmdIndex(d, { dryRun, log, approve = false }) {
    requireStore(d)
    if (dryRun) {
        const { content, invalid } = generateIndex(d.root, d.projectId)
        log(content)
        if (invalid.length) log(`(${invalid.length} invalid doc(s) listed above)`)
        return
    }
    const release = await acquireLock(d.root, 'index')
    try {
        // Grant pre-flight: refuse BEFORE INDEX.md is rewritten. Without this, a refusal
        // thrown by commitAll below left a dirty INDEX.md listing the refused doc — served
        // by the catalog until the next successful index run. Same check, earlier.
        enforceGrants(d.root, uncommittedPaths(d.root), { approve })
        const { changed, docs, invalid } = runIndex(d.root, d.projectId)
        const dirty = storeGit(d.root, ['status', '--porcelain'])
        const dirtyCount = dirty ? dirty.split('\n').length : 0
        const committed =
            dirtyCount > 0 && commitAll(d.root, `kaut: index-gen (${docs} docs, ${dirtyCount} files changed)`, { approve })
        log(
            `index: ${docs} docs, ${invalid.length} invalid, INDEX ${changed ? 'updated' : 'unchanged'}, ${
                committed ? 'committed' : 'no commit needed'
            }`,
        )
        for (const inv of invalid) log(`  invalid: ${inv.path} — ${inv.errors.join('; ')}`)
    } finally {
        release()
    }
}

/**
 * `kaut doctor` — mechanical integrity checks. Exit 1 on any FAIL.
 * @param {ReturnType<typeof discover>} d
 * @param {{log: (s: string) => void}} opts
 */
function cmdDoctor(d, { log }) {
    /** @type {Array<{name: string, status: 'PASS'|'FAIL'|'WARN', detail?: string}>} */
    const checks = []
    /**
     * @param {string} name
     * @param {'PASS'|'FAIL'|'WARN'} status
     * @param {string} [detail]
     */
    const report = (name, status, detail) => checks.push({ name, status, detail })

    // 1. Store exists and is a git repo.
    if (!existsSync(d.root)) report('store-exists', 'FAIL', `missing: ${d.root}`)
    else if (!existsSync(path.join(d.root, '.git'))) report('store-git', 'FAIL', 'not a git repository')
    else {
        report('store-exists', 'PASS')
        // 2. KAUT identity (WARN — data integrity is unaffected).
        const name = tryGit(['config', 'user.name'], d.root)
        report('store-identity', name === 'KAUT' ? 'PASS' : 'WARN', name === 'KAUT' ? undefined : `user.name="${name}"`)
        // 2b. Working tree clean (v0.2.1): every byte served must come from a KAUT commit;
        // lookup withholds anything listed here as `tampered`.
        const dirty = [...uncommittedPaths(d.root)]
        report('store-clean', dirty.length === 0 ? 'PASS' : 'FAIL',
            dirty.length ? `uncommitted (withheld from lookup): ${dirty.slice(0, 5).join(', ')}${dirty.length > 5 ? ` +${dirty.length - 5} more` : ''}` : undefined)
        // 2c. Commit authorship (WARN — authorship is trivially spoofable, so this catches
        // honest accidents like a human `git commit` in the store, not a determined attacker).
        const authors = tryGit(['log', '--format=%an'], d.root) ?? ''
        const foreign = [...new Set(authors.split('\n').filter((a) => a && a !== 'KAUT'))]
        report('store-authors', foreign.length === 0 ? 'PASS' : 'WARN',
            foreign.length ? `non-KAUT commit author(s): ${foreign.join(', ')}` : undefined)
    }

    // 3. Config parses and schema is known.
    const configPath = storeConfigPath(d.root)
    let config = null
    if (!existsSync(configPath)) report('config', 'FAIL', `${CONFIG_NAME} missing`)
    else {
        try {
            config = JSON.parse(readFileSync(configPath, 'utf8'))
            if (config.schema !== 1) report('config', 'FAIL', `unknown config schema "${config.schema}"`)
            else report('config', 'PASS')
        } catch (e) {
            report('config', 'FAIL', `config does not parse: ${e.message}`)
        }
    }

    // 4. Pointer agreement with derivation (WARN — an override is legal, but visible).
    const pointerPath = path.join(d.repo, POINTER_NAME)
    if (existsSync(pointerPath)) {
        try {
            const pointer = JSON.parse(readFileSync(pointerPath, 'utf8'))
            const derived = path.join(kautHome(), deriveProjectId(d.repo))
            report(
                'pointer',
                pointer.root === derived ? 'PASS' : 'WARN',
                pointer.root === derived ? undefined : `pointer.root=${pointer.root} ≠ derived ${derived}`,
            )
        } catch (e) {
            report('pointer', 'WARN', `pointer does not parse: ${e.message}`)
        }
    } else report('pointer', 'WARN', 'no .kaut.json (derivation still resolves the store)')

    // 5–7. Docs parse + grammar; file: sources exist (WARN); INDEX in sync.
    if (existsSync(d.root)) {
        const { content, docs, invalid } = generateIndex(d.root, d.projectId)
        report('docs-valid', invalid.length === 0 ? 'PASS' : 'FAIL',
            invalid.length ? invalid.map((i) => `${i.path}: ${i.errors.join('; ')}`).join(' | ') : `${docs.length} docs`)

        const missing = missingFileSources(d, resolveFreshnessRepo(d).repo)
        report('file-sources-exist', missing.length === 0 ? 'PASS' : 'WARN',
            missing.length ? `missing in repo: ${missing.join(', ')}` : undefined)

        const indexPath = path.join(d.root, 'INDEX.md')
        const inSync = existsSync(indexPath) && readFileSync(indexPath, 'utf8') === content
        report('index-in-sync', inSync ? 'PASS' : 'FAIL', inSync ? undefined : 'run "kaut index"')

        // 8. Draft queue visibility (ROT block 2): pending drafts are healthy, but the owner
        // should see the queue growing — WARN, never FAIL.
        const drafts = listDrafts(d.root)
        report('drafts-pending', drafts.length === 0 ? 'PASS' : 'WARN',
            drafts.length ? `${drafts.length} draft(s) awaiting review: ${drafts.slice(0, 5).join(', ')}${drafts.length > 5 ? ` +${drafts.length - 5} more` : ''}` : undefined)

        // 9. Lock state.
        const lockDir = path.join(d.root, '.lock')
        if (!existsSync(lockDir)) report('lock', 'PASS')
        else {
            let owner = null
            try {
                owner = JSON.parse(readFileSync(path.join(lockDir, 'owner.json'), 'utf8'))
            } catch { /* unreadable owner — still just a WARN */ }
            report('lock', 'WARN', `lock present (op=${owner?.op ?? '?'}, pid=${owner?.pid ?? '?'})`)
        }
    }

    let failed = 0
    for (const c of checks) {
        if (c.status === 'FAIL') failed++
        log(`${c.status.padEnd(5)} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`)
    }
    log(failed === 0 ? 'doctor: healthy' : `doctor: ${failed} check(s) FAILED`)
    if (failed > 0) throw new ValidationError('doctor found failures')
}

/**
 * Collect `file:` sources cited by valid docs that do not exist in the project repo.
 * Checks plain `file:` entries only — glob matching (and the matched-count/`broken` logic)
 * belongs to Phase 1's stale-check; here a WARN is enough. `repo:`
 * sources are checked by the stale path, not here.
 * @param {ReturnType<typeof discover>} d
 * @param {string} [anchorRepo] freshness repo (v0.3.0 anchorRepo-aware); default = cwd repo
 * @returns {string[]} repo-relative paths cited but absent, prefixed with the citing doc
 */
function missingFileSources(d, anchorRepo = d.repo) {
    const missing = []
    for (const rel of scanStore(d.root)) {
        const v = validateDoc(rel, readFileSync(path.join(d.root, rel), 'utf8'))
        if (!v.ok) continue
        const { sources } = parseSources(/** @type {string[]} */ (v.fields.sources))
        for (const s of sources) {
            if (s.type !== 'file') continue
            if (!existsSync(path.join(anchorRepo, s.filePath))) missing.push(`${rel}: ${s.filePath}`)
        }
    }
    return missing
}

/**
 * Current branch name for journal records (diagnostics only).
 * @param {string} repo
 * @returns {string}
 */
function currentBranch(repo) {
    return tryGit(['rev-parse', '--abbrev-ref', 'HEAD'], repo) ?? 'HEAD'
}

/**
 * Atomic file write inside the store: tmp in the same dir, then rename.
 * @param {string} abs absolute target path
 * @param {string} content
 */
function atomicWrite(abs, content) {
    const tmp = `${abs}.tmp`
    writeFileSync(tmp, content)
    renameSync(tmp, abs)
}

/**
 * `kaut stale` — read-path freshness verdicts; NO lock taken (verdicts are
 * computed, never stored). Exit 0 even when docs are stale — a status is data, not an error.
 * @param {ReturnType<typeof discover>} d
 * @param {{log: (s: string) => void, json: boolean}} opts
 * @param {string[]} ids optional subset of doc ids
 */
function cmdStale(d, { log, json }, ids) {
    requireStore(d)
    const fr = resolveFreshnessRepo(d) // v0.3.0: a store may anchor to a different repo
    const rows = staleAll(d.root, fr.repo, fr.mainBranch, ids.length ? ids : undefined)
    // Tamper override (v0.2.1): store-side verdict, outranks everything incl. INVALID — an
    // out-of-pipeline edit explains a parse failure better than the parse error does.
    const uncommitted = uncommittedPaths(d.root)
    for (const r of rows) {
        if (!uncommitted.has(`${r.id}.md`)) continue
        r.verdict = VERDICT.TAMPERED
        r.affected = []
        r.notes = ['uncommitted edit in the store — content withheld from lookup']
    }
    if (json) {
        console.log(JSON.stringify(rows, null, 2))
        return
    }
    if (rows.length === 0) {
        log('(no docs)')
        return
    }
    for (const r of rows) {
        if (r.verdict === null) {
            log(`${'INVALID'.padEnd(16)} ${r.id} — ${(r.errors ?? []).join('; ')}`)
            continue
        }
        const aff = r.affected.length
            ? ` [${r.affected.slice(0, 3).join(', ')}${r.affected.length > 3 ? ` +${r.affected.length - 3}` : ''}]`
            : ''
        const note = r.notes.length ? ` (${r.notes[0]})` : ''
        log(`${r.verdict.padEnd(16)} ${r.id}${aff}${note}`)
    }
}

/**
 * Load a workspace registry by name (additive). Reuses the registry reader so path/cache
 * rules stay identical to the rest of the engine's workspace resolution.
 * @param {string} name workspace name
 * @returns {object} the parsed registry
 * @throws {WorkspaceError} when no registry of that name is registered
 */
function loadWorkspaceRegistry(name) {
    const all = listWorkspaces()
    const reg = all.find((r) => r.name === name)
    if (!reg)
        throw new WorkspaceError(
            `unknown workspace "${name}" — registered: ${all.map((r) => r.name).join(', ') || '(none)'} (run "kaut workspace init")`,
        )
    return reg
}

/**
 * Resolve a descriptor for every CHECKABLE store of a workspace: the system store (resolved
 * exactly as a conductor-cwd run resolves it, via the conductor pointer) + each member store.
 * Members with storePolicy "do-not-touch" (e.g. a gated store) or with no store on disk are
 * SKIPPED — never opened — so a workspace-wide check is gate-safe by construction.
 * @param {object} reg registry
 * @param {(s: string) => void} log
 * @returns {Array<{label: string, d: ReturnType<typeof discover>}>}
 */
function workspaceStores(reg, log) {
    const out = []
    if (reg.systemStore?.root && reg.conductorRepo && existsSync(reg.systemStore.root)) {
        try {
            out.push({ label: reg.systemStore.id ?? 'system', d: discover({ cwd: reg.conductorRepo }) })
        } catch (e) {
            log(`-- skip ${reg.systemStore.id ?? 'system'}: ${e.message}`)
        }
    }
    for (const m of reg.repos ?? []) {
        if (m.storePolicy === 'do-not-touch') {
            log(`-- skip ${m.name} [do-not-touch]`)
            continue
        }
        if (!m.storeRoot || !existsSync(m.storeRoot)) {
            log(`-- skip ${m.name} [no store]`)
            continue
        }
        try {
            out.push({ label: m.name, d: discover({ cwd: m.path }) })
        } catch (e) {
            log(`-- skip ${m.name}: ${e.message}`)
        }
    }
    return out
}

/**
 * `kaut doctor --workspace <name>` (additive) — run doctor across every store of a workspace
 * in ONE process (replaces the per-store spawn loop a conductor would otherwise do). Per-store
 * failures are isolated; a non-zero exit is raised iff ANY store failed (single-store
 * semantics preserved).
 * @param {string} name
 * @param {{log: (s: string) => void}} opts
 */
function cmdDoctorWorkspace(name, opts) {
    const { log } = opts
    const stores = workspaceStores(loadWorkspaceRegistry(name), log)
    let failed = 0
    for (const { label, d } of stores) {
        log(`\n== ${label} ==`)
        try {
            requireStore(d)
            cmdDoctor(d, opts)
        } catch (e) {
            failed++
            log(`doctor: ${e.message}`)
        }
    }
    log(`\nworkspace doctor: ${stores.length} store(s) checked, ${failed} with failures`)
    if (failed > 0) throw new ValidationError(`doctor found failures in ${failed} store(s)`)
}

/**
 * `kaut stale --workspace <name>` (additive) — freshness verdicts across every store of a
 * workspace in ONE process. Always exit 0 (a status is data, not an error). With --json each
 * store prints its own array under a header (not one combined document).
 * @param {string} name
 * @param {{log: (s: string) => void, json: boolean}} opts
 * @param {string[]} ids optional doc-id subset
 */
function cmdStaleWorkspace(name, opts, ids) {
    const { log } = opts
    const stores = workspaceStores(loadWorkspaceRegistry(name), log)
    for (const { label, d } of stores) {
        log(`\n== ${label} ==`)
        try {
            cmdStale(d, opts, ids)
        } catch (e) {
            log(`stale: ${e.message}`)
        }
    }
}

/**
 * `kaut digest [--workspace <name>] [--since <ISO-date>] [--json]` (A) — aggregate the usage journals
 * across every store of a workspace (all registered workspaces when --workspace is omitted) into one
 * picture: reach (lookups w/ verdict/trust/altitude, hit/miss), self-maintenance (writes by tier), and
 * the value signal (op:outcome from `kaut note`). Read-only telemetry — no lock, tolerates a non-store
 * cwd, reads store roots straight from the registry (so even do-not-touch stores report their journals).
 * @param {{log: (s: string) => void, json: boolean}} opts
 * @param {{since?: string, workspace?: string}} [sel]
 */
function cmdDigest({ log, json }, { since, workspace } = {}) {
    const regs = workspace ? [loadWorkspaceRegistry(workspace)] : listWorkspaces()
    const stores = []
    for (const reg of regs) {
        if (reg.systemStore?.root)
            stores.push({ label: reg.systemStore.id ?? `${reg.name}-system`, root: reg.systemStore.root })
        for (const m of reg.repos ?? []) if (m.storeRoot) stores.push({ label: m.name, root: m.storeRoot })
    }
    const events = []
    for (const s of stores)
        for (const rec of readJournal(s.root))
            if (!since || String(rec.ts) >= since) events.push({ ...rec, store: s.label })
    const stats = aggregate(
        events,
        stores.map((s) => s.label),
    )
    if (json) console.log(JSON.stringify(stats, null, 2))
    else log(renderDigest(stats))
}

/**
 * `kaut lookup [<id>]` (SCHEMA §12) — read-path, NO lock; appends a
 * journal record (O_APPEND, lock-free). No id → catalog (the INDEX). Unknown id → miss (exit 0).
 * @param {ReturnType<typeof discover>} d
 * @param {{log: (s: string) => void}} opts
 * @param {string|undefined} id
 */
function cmdLookup(d, { log, json }, id) {
    requireStore(d)
    const branch = currentBranch(d.repo)
    // --json (additive): emit the same data the text block carries — the structured verdict plus
    // the trust-safe rendered block under `render`. Journaling and exit codes are byte-identical
    // to the text path; the default (no --json) output is unchanged. This is the seam a future
    // MCP knowledge-tool wraps.
    const emit = (payload, text) => {
        if (json) console.log(JSON.stringify(payload, null, 2))
        else log(text)
    }

    // Tamper containment (v0.2.1): anything not byte-identical to the last KAUT commit is
    // withheld — checked BEFORE the file is read, parsed, or rendered in any way.
    const uncommitted = uncommittedPaths(d.root)

    if (!id) {
        const indexPath = path.join(d.root, 'INDEX.md')
        // Containment applies to the catalog too: a dirty INDEX.md is WITHHELD, not served
        // with a warning — an out-of-pipeline row (e.g. left behind by a crashed run) would
        // otherwise feed unreviewed titles straight into a reader's context.
        const indexText = uncommitted.has('INDEX.md')
            ? '⚠ INDEX.md has uncommitted edits — withheld; run "kaut index" to regenerate it'
            : existsSync(indexPath) ? readFileSync(indexPath, 'utf8').trimEnd() : '(no INDEX — run "kaut index")'
        if (json) {
            // docs[] is a fresh scan of the working tree — filter tampered entries so their
            // titles never ride the structured payload either.
            const docs = generateIndex(d.root, d.projectId)
                .docs.filter((x) => !uncommitted.has(`${x.id}.md`))
                .map((x) => ({ id: x.id, title: x.title }))
            console.log(JSON.stringify({ mode: 'catalog', docs, render: indexText }, null, 2))
        } else log(indexText)
        appendJournal(d.root, { op: 'lookup', mode: 'catalog', branch })
        return
    }
    id = assertDocId(id)

    const rel = id.endsWith('.md') ? id : `${id}.md`
    const cleanId = rel.replace(/\.md$/, '')
    const abs = path.join(d.root, rel)
    // Covers edits, out-of-pipeline additions AND deletions (a deleted tracked doc is not a
    // miss — it still exists in the last KAUT commit; checkout restores it).
    if (uncommitted.has(rel)) {
        const text = renderTampered(cleanId, cleanId.startsWith('map/')).trimEnd()
        // withheld: the payload carries NO file content, only the safe render — the same
        // injection channel the tampered verdict exists to close.
        emit({ id: cleanId, verdict: VERDICT.TAMPERED, withheld: true, render: text }, text)
        appendJournal(d.root, { op: 'lookup', topic: cleanId, verdict: VERDICT.TAMPERED, mode: 'withheld', branch })
        return
    }
    if (!existsSync(abs)) {
        const docs = generateIndex(d.root, d.projectId).docs.map((x) => ({ id: x.id, title: x.title }))
        const nearest = nearestDocs(cleanId, docs)
        const text = renderMiss(cleanId, nearest).trimEnd()
        emit({ id: cleanId, mode: 'miss', nearest, render: text }, text)
        appendJournal(d.root, { op: 'lookup', topic: cleanId, mode: 'miss', branch })
        return
    }

    const raw = readFileSync(abs, 'utf8')
    const v = validateDoc(rel, raw)
    if (!v.ok) {
        const text = `# kaut: ${cleanId}\nINVALID — ${v.errors.join('; ')}`
        emit({ id: cleanId, mode: 'invalid', errors: v.errors, render: text }, text)
        appendJournal(d.root, { op: 'lookup', topic: cleanId, mode: 'invalid', branch })
        return
    }
    const fr = resolveFreshnessRepo(d) // v0.3.0: a store may anchor to a different repo
    const ctx = createContext(fr.repo, fr.mainBranch)
    const body = parseFrontmatter(raw).body
    const result = verdictForDoc({ fields: v.fields, body }, ctx)
    // Draft-queue visibility on the read path: a reader (and the owner) learns a newer
    // version awaits review without the draft's CONTENT ever being served (queue ≠ knowledge).
    const DRAFT_NOTE = 'a pending draft for this doc awaits owner review (kaut review)'
    const hasDraft = existsSync(draftPath(d.root, cleanId))
    if (hasDraft) result.notes.push(DRAFT_NOTE)
    const alt = altitudeFor({ id: cleanId, sources: v.fields.sources })
    const text = renderLookup({ id: cleanId, fields: v.fields, body }, result).trimEnd() + (hasDraft ? `\n\nnote: ${DRAFT_NOTE}` : '')
    emit(
        {
            id: cleanId,
            trust: String(v.fields.trust),
            verdict: result.verdict,
            // altitude (A3): coverage/granularity band — orthogonal to verdict; the machine flag
            // (confirmDirective) lets an MCP/orchestrator wrapper gate confident extrapolation off a
            // coarse doc rather than parsing prose. Always emitted, for every band.
            altitude: alt,
            derived_from_commit: String(v.fields.derived_from_commit ?? '').slice(0, 12),
            affected: result.affected,
            notes: result.notes,
            render: text,
        },
        text,
    )
    appendJournal(d.root, {
        op: 'lookup',
        topic: cleanId,
        verdict: result.verdict,
        trust: String(v.fields.trust),
        // altitude band (A; digest groups coarse vs precise reads) — orthogonal to verdict.
        altitude: alt.band,
        mode: result.verdict === VERDICT.HEALTHY ? 'full' : 'partial',
        branch,
    })
}

/**
 * The closed set of in-session outcomes a session may record for a doc it USED (the outcome value signal,
 * `op:outcome`). Objective follow-up events, not subjective ratings:
 *  - trusted      — used the doc, did NOT read code (the efficiency win KAUT exists for)
 *  - confirmed    — trusted the lead but verified in code anyway (partial value; the §4.2 confirm)
 *  - insufficient — the doc did not answer; fell back to reading code (a coverage/depth gap)
 *  - stale-misled — the doc was wrong/stale and sent the session the wrong way (negative value)
 * Misses are already logged by `lookup` (mode:miss); this captures what happened AFTER a hit.
 */
const OUTCOMES = ['trusted', 'confirmed', 'insufficient', 'stale-misled']

/**
 * `kaut note <topic> <result> [--note "…"]` (outcome value signal) — append an `op:outcome` telemetry
 * record for a doc the session used. Honor-system (the engine cannot prove it), like all of distill;
 * the knowledge-update skill emits it. Resolves the store from cwd, like `lookup`. No store write,
 * no lock — telemetry only. Unknown result is rejected so a typo never pollutes the signal.
 * @param {ReturnType<typeof discover>} d
 * @param {{log: (s: string) => void}} opts
 * @param {string|undefined} topic
 * @param {string|undefined} result
 * @param {string|undefined} note
 */
function cmdNote(d, { log }, topic, result, note) {
    requireStore(d)
    if (!topic || !result)
        throw new ValidationError(`usage: kaut note <topic> <${OUTCOMES.join('|')}> [--note "…"]`)
    if (!OUTCOMES.includes(result))
        throw new ValidationError(`unknown outcome "${result}" — expected ${OUTCOMES.join('|')}`)
    topic = assertDocId(topic)
    const branch = currentBranch(d.repo)
    appendJournal(d.root, { op: 'outcome', topic, result, ...(note ? { note } : {}), branch })
    log(`noted: ${topic} → ${result}`)
}

/**
 * `kaut refresh [<id>…]` (ROT block 3) — per-doc re-derivation delta bundles: the target ref
 * (tracked main TIP, never working-tree HEAD), changed sources with git status, hit sections,
 * dead patterns, and anchor triage (wrong-repo / off-main). Read-only: no lock, no journal
 * (like stale/doctor). The agent rewrites prose from the delta; the write gate lands it.
 * @param {ReturnType<typeof discover>} d
 * @param {{log: (s: string) => void, json: boolean}} opts
 * @param {string[]} ids optional doc-id subset
 */
function cmdRefresh(d, { log, json }, ids) {
    requireStore(d)
    ids = ids.map(assertDocId)
    const fr = resolveFreshnessRepo(d)
    const { target, mainRef, rows } = buildRefresh(d.root, fr.repo, fr.mainBranch, ids.length ? ids : undefined)
    if (json) {
        console.log(JSON.stringify({ target, mainRef, rows }, null, 2))
        return
    }
    log(`refresh target: ${target ? target.slice(0, 12) : '(unresolvable)'} (${mainRef})`)
    for (const r of rows) {
        if (r.status === REFRESH.CURRENT) {
            log(`${'current'.padEnd(18)} ${r.id}`)
            continue
        }
        log(`${r.status.padEnd(18)} ${r.id}${r.status === REFRESH.INVALID ? ` — ${(r.errors ?? []).join('; ')}` : ''}`)
        const cap = (arr) => `${arr.slice(0, 6).join(', ')}${arr.length > 6 ? ` +${arr.length - 6} more` : ''}`
        if (r.changed?.length) log(`    changed: ${cap(r.changed.map((c) => `${c.gitStatus} ${c.path}`))}`)
        if (r.broken?.length) log(`    re-bind (dead at target): ${cap(r.broken)}`)
        if (r.repoBroken?.length) log(`    re-bind (dead repo source): ${cap(r.repoBroken)}`)
        for (const s of r.sections ?? []) log(`    section "${s.heading}": ${cap(s.affected)}`)
        for (const n of r.notes) log(`    note: ${n}`)
        if (r.directive) log(`    → ${r.directive}`)
    }
}

/**
 * `kaut draft <id>` (ROT block 2) — queue a finished doc update for asynchronous owner review.
 * The agent first writes the COMPLETE updated doc to `<store>/.drafts/<id>.md`, then runs this
 * command: the draft is contract-validated, its anchor is verified against the anchor repo's
 * main line (the wrong-repo / branch-anchored classes die at the queue door), and it is
 * committed through the ordinary chokepoint (drafts are not layer docs — no --approve needed,
 * and lookup never serves them). Owner lands the batch later via `kaut review --approve`.
 * @param {ReturnType<typeof discover>} d
 * @param {{log: (s: string) => void}} opts
 * @param {string|undefined} id
 */
async function cmdDraft(d, { log }, id) {
    requireStore(d)
    if (!id)
        throw new ValidationError('usage: kaut draft <id> — after writing the full updated doc to <store>/.drafts/<id>.md')
    id = assertDocId(id)
    // A draft outside the knowledge layers would promote into a path scanStore never visits
    // — committed, invisible, dead. Refuse at the queue door.
    if (!LAYER_DIRS.includes(typeForId(id)))
        throw new ValidationError(`draft id must live in a knowledge layer (${LAYER_DIRS.join('|')}): ${id}`)
    const abs = draftPath(d.root, id)
    if (!existsSync(abs))
        throw new ValidationError(`no draft file at ${abs} — write the complete updated doc there first`)
    const v = validateDoc(`${id}.md`, readFileSync(abs, 'utf8'))
    if (!v.ok) throw new ValidationError(`draft invalid: ${v.errors.join('; ')}`)
    const fr = resolveFreshnessRepo(d)
    const derived = String(v.fields.derived_from_commit)
    const { mainRef } = resolveAnchor(fr.repo, fr.mainBranch)
    if (tryGit(['rev-parse', '--verify', '--quiet', `${derived}^{commit}`], fr.repo) === null)
        throw new ValidationError(
            `draft anchor ${derived.slice(0, 12)} is not a commit of the anchor repo (${fr.repo}) — wrong-repo anchor; re-derive against ${mainRef}`,
        )
    if (tryGit(['merge-base', '--is-ancestor', derived, mainRef], fr.repo) === null)
        throw new ValidationError(
            `draft anchor ${derived.slice(0, 12)} is not on the main line (${mainRef}) — anchor the re-derivation to the tracked main ref, not a branch`,
        )
    const release = await acquireLock(d.root, 'draft')
    try {
        const committed = commitAll(d.root, `kaut: draft (${id})`)
        log(`draft queued: ${id}${committed ? '' : ' (already committed)'} — owner lands it via "kaut review --approve ${id}"`)
    } finally {
        release()
    }
    appendJournal(d.root, { op: 'draft', topic: id, branch: currentBranch(d.repo) })
}

/**
 * Render one pending draft against the current committed doc (unified diff; full text for a
 * NEW doc). `git diff --no-index` exits 1 when files differ — the diff arrives via stdout of
 * the thrown error, which is the expected path here.
 * @param {string} root store root
 * @param {string} id
 * @param {(s: string) => void} log
 */
function renderDraftDiff(root, id, log) {
    const cur = path.join(root, `${id}.md`)
    const draft = draftPath(root, id)
    if (!existsSync(cur)) {
        log(`NEW doc ${id} — full draft:\n`)
        log(readFileSync(draft, 'utf8'))
        return
    }
    try {
        execFileSync('git', ['diff', '--no-index', '--', cur, draft], { encoding: 'utf8' })
        log(`(draft is byte-identical to the current doc) ${id}`)
    } catch (e) {
        log(String(e.stdout ?? ''))
    }
}

/**
 * `kaut review` (ROT block 2) — the owner's side of the draft queue.
 *   review                       list pending drafts
 *   review <id>…                 show the diff(s)
 *   review --approve <id>…       promote + land (OWNER-RUN; flows through the gate with approve)
 *   review --reject <id>… [--note "…"]   drop the draft(s), note recorded in the commit message
 * @param {ReturnType<typeof discover>} d
 * @param {{log: (s: string) => void, json: boolean}} opts
 * @param {string[]} ids
 * @param {{approve: boolean, reject: boolean, note?: string}} flags
 */
async function cmdReview(d, { log, json }, ids, { approve, reject, note }) {
    requireStore(d)
    ids = ids.map(assertDocId)
    const pending = listDrafts(d.root)
    if (approve && reject) throw new ValidationError('pick one of --approve / --reject')
    if (!approve && !reject) {
        if (!ids.length) {
            if (json) {
                console.log(JSON.stringify(pending.map((id) => ({ id, kind: existsSync(path.join(d.root, `${id}.md`)) ? 'update' : 'new' })), null, 2))
                return
            }
            if (!pending.length) {
                log('(no pending drafts)')
                return
            }
            for (const id of pending) log(`${(existsSync(path.join(d.root, `${id}.md`)) ? 'update' : 'NEW doc').padEnd(8)} ${id}`)
            log(`\n${pending.length} draft(s) pending — "kaut review <id>" shows the diff; "kaut review --approve <id>…" lands (owner-run)`)
            return
        }
        for (const id of ids) {
            if (!pending.includes(id)) throw new ValidationError(`no pending draft: ${id}`)
            renderDraftDiff(d.root, id, log)
        }
        return
    }
    if (!ids.length) throw new ValidationError(`usage: kaut review --${approve ? 'approve' : 'reject'} <id>…`)
    for (const id of ids) if (!pending.includes(id)) throw new ValidationError(`no pending draft: ${id}`)
    const release = await acquireLock(d.root, 'review')
    try {
        if (approve) {
            for (const id of ids) promoteDraft(d.root, id)
            runIndex(d.root, d.projectId)
            commitAll(d.root, `kaut: review-approve (${ids.join(', ')})`, { approve: true })
            log(`approved + landed: ${ids.join(', ')}`)
        } else {
            for (const id of ids) removeDraft(d.root, id)
            commitAll(d.root, `kaut: review-reject (${ids.join(', ')})${note ? ` — ${note}` : ''}`)
            log(`rejected: ${ids.join(', ')}`)
        }
    } finally {
        release()
    }
}

/**
 * `kaut touched <repo-relative-file>…` (ROT block 5.1) — which docs bind the given files?
 * The change-site sensor: a session that edited files runs this before closing; a non-empty
 * answer names the docs it owes an update/draft to. Pure read — no lock, no journal.
 * Matches doc-level AND section-level source bindings (union).
 * @param {ReturnType<typeof discover>} d
 * @param {{log: (s: string) => void, json: boolean}} opts
 * @param {string[]} files repo-relative paths (as git prints them)
 */
function cmdTouched(d, { log, json }, files) {
    requireStore(d)
    if (!files.length) throw new ValidationError('usage: kaut touched <repo-relative-file>…')
    const rows = []
    for (const rel of scanStore(d.root)) {
        const raw = readFileSync(path.join(d.root, rel), 'utf8')
        const v = validateDoc(rel, raw)
        if (!v.ok) continue
        const patterns = [.../** @type {string[]} */ (Array.isArray(v.fields.sources) ? v.fields.sources : [])]
        for (const s of parseSections(parseFrontmatter(raw).body).sections) patterns.push(...s.sources)
        const matched = new Set()
        for (const s of parseSources(patterns).sources)
            if (FILE_TYPES.has(s.type))
                for (const f of filterMatch(/** @type {string} */ (s.filePath), files)) matched.add(f)
        if (matched.size) rows.push({ id: rel.replace(/\.md$/, ''), matched: [...matched] })
    }
    if (json) {
        console.log(JSON.stringify(rows, null, 2))
        return
    }
    if (!rows.length) {
        log('(no docs bind these files)')
        return
    }
    for (const r of rows) log(`${r.id} — ${r.matched.join(', ')}`)
    log(`\n${rows.length} doc(s) bind the touched files — update (agent layer) or draft (owner layer) before closing`)
}

/**
 * `kaut map` — regenerate the L0 maps under the write lock and commit once.
 * Route-map drift (D12) aborts before any write (exit 1, nothing changed).
 * @param {ReturnType<typeof discover>} d
 * @param {{dryRun: boolean, log: (s: string) => void, approve?: boolean}} opts
 */
async function cmdMap(d, { dryRun, log, approve = false }) {
    requireStore(d)
    const fr = resolveFreshnessRepo(d) // v0.3.0: maps derive from the store's anchor repo
    const { anchor } = resolveAnchor(fr.repo, fr.mainBranch)
    const meta = { derived: anchor ?? 'unknown', harvested: new Date().toISOString().slice(0, 10), version: ENGINE_VERSION }

    // v0.3.0 collector selection: a store config may declare `map.collectors`; absent key =
    // the historical pair — existing stores behave identically.
    const cfg = storeConfig(d.root)
    const collectors = cfg?.map?.collectors ?? ['routemap', 'pkggraph']
    if (collectors.length === 0) {
        log('map: no collectors configured (map.collectors: []) — nothing to do')
        return
    }

    /** @type {Array<{rel: string, content: string, topic: string, label: string}>} */
    const outputs = []
    for (const name of collectors) {
        if (name === 'routemap') {
            let route
            try {
                // file locations are config (engine-vs-data); absent keys = stack defaults
                route = buildRouteMap(fr.repo, meta, {
                    routesFile: cfg?.map?.routesFile,
                    constantsFile: cfg?.map?.constantsFile,
                }) // throws RouteMapError on drift — caught below
            } catch (e) {
                // Absence is a stack mismatch, not an error: the default routes location is
                // stack-conventional, so a repo without it skips this collector (the rest
                // still run) instead of aborting the whole map build. Parse drift stays loud.
                if (e instanceof RouteMapError && /not found/.test(e.message)) {
                    log(`map: routemap skipped — ${e.message} (configure map.routesFile or map.collectors)`)
                    continue
                }
                if (e instanceof RouteMapError) throw new ValidationError(`map: ${e.message}`)
                throw e
            }
            outputs.push({ rel: path.join('map', 'routes.md'), content: route.content, topic: 'map/routes', label: `${route.routeCount} routes` })
        } else if (name === 'pkggraph') {
            const pkg = buildPackageGraph(fr.repo, meta, { packagesDir: cfg?.map?.packagesDir })
            outputs.push({ rel: path.join('map', 'packages.md'), content: pkg.content, topic: 'map/packages', label: `${pkg.packageCount} packages` })
        } else if (name === 'composemap') {
            let cm
            try {
                cm = buildComposeMap(fr.repo, meta, { composeFile: cfg?.map?.composeFile ?? 'docker-compose.yml' })
            } catch (e) {
                if (e instanceof ComposeMapError) throw new ValidationError(`map: ${e.message}`)
                throw e
            }
            outputs.push({ rel: path.join('map', 'services.md'), content: cm.content, topic: 'map/services', label: `${cm.serviceCount} services` })
        } else {
            throw new ValidationError(`map: unknown collector "${name}" in kaut.config.json map.collectors`)
        }
    }
    if (outputs.length === 0) {
        log('map: every collector was skipped — nothing to write')
        return
    }
    const labels = outputs.map((o) => o.label).join(', ')

    if (dryRun) {
        log(`map (dry-run): ${labels} — no write`)
        return
    }

    const release = await acquireLock(d.root, 'map')
    try {
        for (const o of outputs) atomicWrite(path.join(d.root, o.rel), o.content)
        const idx = runIndex(d.root, d.projectId)
        const committed = commitAll(d.root, `kaut: map-gen (${labels})`, { approve })
        const branch = currentBranch(d.repo)
        for (const o of outputs)
            appendJournal(d.root, { op: 'map', topic: o.topic, verdict: null, trust: 'T0', mode: 'full', branch })
        log(
            `map: ${labels}, INDEX ${idx.changed ? 'updated' : 'unchanged'}, ${
                committed ? 'committed' : 'no commit needed'
            }`,
        )
    } finally {
        release()
    }
}

/**
 * `kaut workspace init|list` (engine v0.3.0, thin slice). `init --manifest <path>` derives
 * the registry + member stores + ONE system store from a conductor manifest; `list` prints
 * the registries. Provisioning reuses the bootstrap core verbatim (discover({cwd}) per
 * member); a member with storePolicy "do-not-touch" gets a registry entry and NOTHING else.
 * @param {{dryRun: boolean, log: (s: string) => void}} opts
 * @param {string[]} rest positionals after "workspace"
 * @param {string|undefined} manifestPath --manifest value (required for init)
 */
async function cmdWorkspace({ dryRun, log }, rest, manifestPath) {
    const sub = rest[0]
    if (sub === 'list') {
        const regs = listWorkspaces()
        if (regs.length === 0) {
            log('(no workspaces — run "kaut workspace init --manifest <conductor>/manifest.json")')
            return
        }
        for (const r of regs) {
            log(`${r.name} — ${r.repos?.length ?? 0} repos, system store ${r.systemStore?.id ?? '?'}`)
            log(`    manifest: ${r.manifestPath}`)
            for (const m of r.repos ?? [])
                log(`    ${m.name} → ${m.storeRoot}${m.storePolicy ? `  [${m.storePolicy}]` : ''}`)
        }
        return
    }
    if (sub !== 'init') throw new ValidationError('usage: kaut workspace <init --manifest <path>|list>')
    if (!manifestPath) throw new ValidationError('workspace init requires --manifest <path to conductor manifest.json>')

    const { manifest, manifestAbs } = loadManifest(manifestPath)
    const plan = planWorkspace(manifest, manifestAbs)

    if (dryRun) {
        log(`workspace ${plan.name} (dry-run): ${plan.members.length} repos, system store ${plan.systemStore.id} — no write`)
        for (const m of plan.members) log(`  ${m.doNotTouch ? 'registry-only' : 'bootstrap'}  ${m.name} → ${m.storeRoot}`)
        return
    }

    // 1. Registry — a derived copy, regenerated wholesale.
    const regFile = writeRegistry(plan, manifestAbs, ENGINE_VERSION)
    log(`registry     ${regFile}`)

    // 2. Member stores — pre-write a NEUTRAL config where the store is new (bootstrap never
    // overwrites an existing config), then run the ordinary bootstrap core.
    for (const m of plan.members) {
        if (m.doNotTouch) {
            log(`registry-only ${m.name} (storePolicy: ${m.storePolicy})`)
            continue
        }
        const md = discover({ cwd: m.path })
        if (!existsSync(storeConfigPath(md.root))) {
            mkdirSync(md.root, { recursive: true })
            writeFileSync(
                path.join(md.root, CONFIG_NAME),
                JSON.stringify(neutralConfig(md, plan.ticketPattern), null, 4) + '\n',
            )
        }
        await cmdBootstrap(md, { dryRun: false, log: (s) => log(`  [${m.name}] ${s}`) })
        const claudeLocal = path.join(m.path, 'CLAUDE.local.md')
        if (!existsSync(claudeLocal)) {
            writeFileSync(claudeLocal, workspacePointerText(plan, { member: m.name }))
            ensureExcludeEntries(m.path, ['CLAUDE.local.md'])
            log(`  [${m.name}] created      CLAUDE.local.md`)
        } else log(`  [${m.name}] exists       CLAUDE.local.md (left untouched)`)
    }

    // 3. System store — an ordinary store anchored to the launcher repo (config
    // project.anchorRepo); no pointer into the launcher (it keeps its own store).
    const s = plan.systemStore
    mkdirSync(s.root, { recursive: true })
    ensureStoreGit(s.root)
    if (!existsSync(path.join(s.root, '.gitignore'))) writeFileSync(path.join(s.root, '.gitignore'), STORE_GITIGNORE)
    if (!existsSync(storeConfigPath(s.root)))
        writeFileSync(path.join(s.root, CONFIG_NAME), JSON.stringify(systemConfig(plan), null, 4) + '\n')
    for (const dir of ['map', 'flows', 'runbook', 'decisions', 'contracts'])
        mkdirSync(path.join(s.root, dir), { recursive: true })
    if (!existsSync(path.join(s.root, 'obligations.jsonl'))) writeFileSync(path.join(s.root, 'obligations.jsonl'), '')
    runIndex(s.root, s.id)
    const committed = commitAll(s.root, `kaut: workspace init v${ENGINE_VERSION}`)
    log(`system store ${s.root} ${committed ? '(committed)' : '(no changes)'}`)

    // 4. Conductor pointer → system store (the documented pointer override; doctor WARNs on
    // pointer≠derived by design). Never clobbers a pointer that points elsewhere.
    const pointerPath = path.join(plan.conductorRepo, POINTER_NAME)
    if (!existsSync(pointerPath)) {
        writeFileSync(
            pointerPath,
            JSON.stringify({ schema: 1, projectId: s.id, root: s.root, engine: ENGINE_DIR }, null, 4) + '\n',
        )
        ensureExcludeEntries(plan.conductorRepo, [POINTER_NAME])
        log(`pointer      ${pointerPath} → ${s.id}`)
    } else {
        let existing = null
        try {
            existing = JSON.parse(readFileSync(pointerPath, 'utf8'))
        } catch { /* unparsable pointer — doctor's department */ }
        log(
            existing?.root === s.root
                ? `pointer      exists (already → ${s.id})`
                : `pointer      EXISTS and points elsewhere (${existing?.root ?? 'unparsable'}) — left untouched`,
        )
    }
    const conductorLocal = path.join(plan.conductorRepo, 'CLAUDE.local.md')
    if (!existsSync(conductorLocal)) {
        writeFileSync(conductorLocal, workspacePointerText(plan, { conductor: true }))
        ensureExcludeEntries(plan.conductorRepo, ['CLAUDE.local.md'])
        log('conductor    created CLAUDE.local.md')
    } else log('conductor    CLAUDE.local.md exists (left untouched)')

    log(`workspace ${plan.name}: ${plan.members.length} repos registered, system store ${s.id}`)
}

/**
 * @param {ReturnType<typeof discover>} d
 * @throws {EnvironmentError} when the store has not been bootstrapped yet
 */
function requireStore(d) {
    if (!existsSync(d.root))
        throw new EnvironmentError(`store not bootstrapped (missing ${d.root}) — run "kaut bootstrap"`)
}

/**
 * Parse the store config, or null when absent/unreadable (`doctor` is where config
 * problems get surfaced; readers degrade to defaults).
 * @param {string} root
 * @returns {object|null}
 */
function storeConfig(root) {
    try {
        return JSON.parse(readFileSync(storeConfigPath(root), 'utf8'))
    } catch {
        return null
    }
}

const USAGE =
    'usage: kaut.mjs <bootstrap|index|doctor|stale|lookup|note|refresh|draft|review|touched|digest|map|workspace|paths> [<id>…] [--manifest <path>] [--workspace <name>] [--since <ISO-date>] [--note <text>] [--approve] [--reject] [--dry-run] [--json] [--quiet]'

async function main() {
    const { values, positionals } = parseArgs({
        allowPositionals: true,
        options: {
            'dry-run': { type: 'boolean', default: false },
            quiet: { type: 'boolean', default: false },
            json: { type: 'boolean', default: false },
            approve: { type: 'boolean', default: false },
            reject: { type: 'boolean', default: false },
            help: { type: 'boolean', short: 'h', default: false },
            manifest: { type: 'string' },
            workspace: { type: 'string' },
            since: { type: 'string' },
            note: { type: 'string' },
        },
    })
    if (values.help) {
        console.log(USAGE)
        return
    }
    const cmd = positionals[0]
    if (!cmd) {
        console.error(USAGE)
        process.exitCode = 1
        return
    }
    const rest = positionals.slice(1)
    const log = values.quiet ? () => {} : (s) => console.log(s)
    const opts = { dryRun: values['dry-run'], json: values.json, approve: values.approve, log }

    // Some commands resolve stores from the registry, not cwd, so a non-store cwd is fine for them:
    // workspace-wide doctor/stale (--workspace) and `digest` (always registry-driven). Single-store
    // behavior is unchanged for every other command.
    const cwdOptional = cmd === 'digest' || (!!values.workspace && (cmd === 'doctor' || cmd === 'stale'))
    let d = null
    try {
        d = discover()
    } catch (e) {
        if (!cwdOptional) throw e
    }
    switch (cmd) {
        case 'bootstrap':
            await cmdBootstrap(d, opts)
            break
        case 'index':
            await cmdIndex(d, opts)
            break
        case 'doctor':
            if (values.workspace) {
                cmdDoctorWorkspace(values.workspace, opts)
                break
            }
            requireStore(d)
            cmdDoctor(d, opts)
            break
        case 'stale':
            if (values.workspace) {
                cmdStaleWorkspace(values.workspace, opts, rest)
                break
            }
            cmdStale(d, opts, rest)
            break
        case 'lookup':
            cmdLookup(d, opts, rest[0])
            break
        case 'note':
            cmdNote(d, opts, rest[0], rest[1], values.note)
            break
        case 'digest':
            cmdDigest(opts, { since: values.since, workspace: values.workspace })
            break
        case 'refresh':
            cmdRefresh(d, opts, rest)
            break
        case 'draft':
            await cmdDraft(d, opts, rest[0])
            break
        case 'review':
            await cmdReview(d, opts, rest, { approve: values.approve, reject: values.reject, note: values.note })
            break
        case 'touched':
            cmdTouched(d, opts, rest)
            break
        case 'map':
            await cmdMap(d, opts)
            break
        case 'workspace':
            await cmdWorkspace(opts, rest, values.manifest)
            break
        case 'paths':
            console.log(JSON.stringify(d, null, 2))
            break
        default:
            console.error(USAGE)
            process.exitCode = 1
    }
}

main().catch((e) => {
    if (e instanceof LockBusyError) {
        console.error(`kaut: ${e.message}`)
        process.exit(2)
    }
    if (e instanceof EnvironmentError) {
        console.error(`kaut: ${e.message}`)
        process.exit(3)
    }
    if (e instanceof WorkspaceError) {
        console.error(`kaut: ${e.message}`)
        process.exit(1)
    }
    console.error(`kaut: ${e?.message ?? e}`)
    process.exit(1)
})
