/**
 * Workspace planning helpers (engine v0.3.0, thin slice).
 *
 * `kaut workspace init --manifest <path>` consumes a CONDUCTOR manifest — the single
 * source of truth owned by the orchestration framework — and derives everything KAUT
 * needs: the registry (a derived copy under ~/.kaut/workspaces/), one store per member
 * repo, and ONE system store anchored to the launcher repo. This module holds the pure
 * parts: manifest loading/validation, plan derivation, registry writing, config shapes,
 * pointer text. The imperative provisioning loop lives in kaut.mjs (cmdWorkspace), next
 * to the other cmd* functions, so it can reuse the bootstrap core directly.
 *
 * Manifest keys consumed: `name`, `launcher{repo, compose}`, `repos[{name, path,
 * storePolicy?}]`, `flow.tracker.ticketPattern?`. Everything else in the manifest belongs
 * to the orchestration framework and is ignored here. A repo with
 * `storePolicy: "do-not-touch"` gets a registry entry and NOTHING else — no bootstrap, no
 * pointer, no working-tree files (e.g. a store owned by another active track).
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { kautHome, deriveProjectId, repoToplevel, tryGit, detectMainBranch } from './discover.mjs'
import { clearRegistryCache, loadRegistries, workspacesDir } from './registry.mjs'

/** Workspace planning/validation error (CLI maps it to exit 1). */
export class WorkspaceError extends Error {
    /** @param {string} message */
    constructor(message) {
        super(message)
        this.code = 'KAUT_WORKSPACE'
    }
}

/**
 * Deterministic system-store id for a workspace: `system-<name>--<sha8>`. The hash key is
 * the NAME (prefixed), not the launcher remote — collision-free with the launcher's own
 * repo store and stable across launcher moves.
 * @param {string} name workspace name (manifest `name`)
 * @returns {string}
 */
export function systemStoreId(name) {
    const safe = String(name).toLowerCase().replace(/[^a-z0-9_-]+/g, '-')
    const hash8 = createHash('sha256').update(`workspace:${name}`).digest('hex').slice(0, 8)
    return `system-${safe}--${hash8}`
}

/**
 * Load and minimally validate a conductor manifest.
 * @param {string} manifestPath
 * @returns {{manifest: any, manifestAbs: string}}
 * @throws {WorkspaceError}
 */
export function loadManifest(manifestPath) {
    const manifestAbs = path.resolve(manifestPath)
    if (!existsSync(manifestAbs)) throw new WorkspaceError(`manifest not found: ${manifestAbs}`)
    let manifest
    try {
        manifest = JSON.parse(readFileSync(manifestAbs, 'utf8'))
    } catch (e) {
        throw new WorkspaceError(`manifest does not parse: ${e.message}`)
    }
    if (!manifest.name || typeof manifest.name !== 'string')
        throw new WorkspaceError('manifest must declare a string "name"')
    if (!Array.isArray(manifest.repos) || manifest.repos.length === 0)
        throw new WorkspaceError('manifest must declare a non-empty "repos" list')
    return { manifest, manifestAbs }
}

/**
 * Derive the full workspace plan from a manifest. Pure + strict: a missing repo path or an
 * unresolvable launcher is an ERROR, never a silent skip — the manifest is the source of
 * truth and a typo must not produce a half-workspace.
 * @param {any} manifest
 * @param {string} manifestAbs
 * @returns {{name: string, conductorRepo: string, ticketPattern: string|null,
 *   members: Array<{name: string, path: string, projectId: string, storeRoot: string,
 *     storePolicy: string|null, writePolicy: Record<string,string>|null, doNotTouch: boolean}>,
 *   systemStore: {id: string, root: string, anchorRepo: string, composeFile: string,
 *     writePolicy: Record<string,string>|null}}}
 * @throws {WorkspaceError}
 */
export function planWorkspace(manifest, manifestAbs) {
    const conductorRepo = repoToplevel(path.dirname(manifestAbs))
    const members = []
    for (const r of manifest.repos) {
        if (!r?.name || !r?.path) throw new WorkspaceError(`repo entry needs name+path: ${JSON.stringify(r)}`)
        if (!existsSync(r.path)) throw new WorkspaceError(`repo "${r.name}" path does not exist: ${r.path}`)
        const top = tryGit(['rev-parse', '--show-toplevel'], r.path)
        if (!top) throw new WorkspaceError(`repo "${r.name}" is not a git repository: ${r.path}`)
        const projectId = deriveProjectId(top)
        members.push({
            name: r.name,
            path: top,
            projectId,
            storeRoot: path.join(kautHome(), projectId),
            storePolicy: r.storePolicy ?? null,
            // Write grant (per-layer): a per-repo override wins over the deployment default; absent
            // ⇒ null ⇒ open-until-configured (the gate stays inert until a writePolicy is set).
            writePolicy: r.writePolicy ?? manifest.defaults?.writePolicy ?? null,
            doNotTouch: typeof r.storePolicy === 'string' && r.storePolicy.startsWith('do-not-touch'),
        })
    }
    const launcherName = manifest.launcher?.repo
    if (!launcherName) throw new WorkspaceError('manifest must declare launcher.repo (the anchor of the system store)')
    const launcher = members.find((m) => m.name === launcherName)
    if (!launcher) throw new WorkspaceError(`launcher.repo "${launcherName}" is not in the repos list`)
    const id = systemStoreId(manifest.name)
    return {
        name: manifest.name,
        conductorRepo,
        ticketPattern: manifest.flow?.tracker?.ticketPattern ?? null,
        members,
        systemStore: {
            id,
            root: path.join(kautHome(), id),
            anchorRepo: launcher.path,
            composeFile: manifest.launcher?.compose ?? 'docker-compose.yml',
            // runbooks (the pilot's Tier-A target) land in the system store → it carries the deployment
            // default writePolicy so the gate covers it (it is NOT a repos[] entry).
            writePolicy: manifest.defaults?.writePolicy ?? null,
        },
    }
}

/**
 * Write the registry (a derived copy; regenerated wholesale on every init) and drop the
 * resolver cache so the running process sees it immediately.
 * @param {ReturnType<typeof planWorkspace>} plan
 * @param {string} manifestAbs
 * @param {string} engineVersion
 * @param {string} [dir]
 * @returns {string} registry file path
 */
export function writeRegistry(plan, manifestAbs, engineVersion, dir = workspacesDir()) {
    mkdirSync(dir, { recursive: true })
    const file = path.join(dir, `${plan.name}.json`)
    const registry = {
        schema: 1,
        name: plan.name,
        generatedBy: `workspace-init@${engineVersion}`,
        manifestPath: manifestAbs,
        conductorRepo: plan.conductorRepo,
        note: 'derived copy — the conductor manifest is the single source of truth; re-run "kaut workspace init" after manifest changes',
        systemStore: plan.systemStore,
        repos: plan.members.map((m) => ({
            name: m.name,
            path: m.path,
            projectId: m.projectId,
            storeRoot: m.storeRoot,
            storePolicy: m.storePolicy,
            writePolicy: m.writePolicy,
        })),
    }
    writeFileSync(file, JSON.stringify(registry, null, 4) + '\n')
    clearRegistryCache()
    return file
}

/**
 * Neutral per-repo store config (NO profile matrix yet — a later concern). Same
 * shape as the historical default but with nothing project-specific baked in: no map
 * collectors, no source globs; ticket pattern comes from the manifest when present.
 * @param {{projectId: string, repo: string, mainBranch: string}} d discovery result
 * @param {string|null} ticketPattern
 * @returns {object}
 */
export function neutralConfig(d, ticketPattern) {
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
        map: { collectors: [] },
        sources: {},
        runtime: {},
        tickets: { pattern: ticketPattern, mcp: null, readOnly: true },
        collectors: { default: ['codebase', 'user-input'], onDemand: [] },
        trust: {
            sourceOverrides: {},
            categoryFloors: { map: 'T0', flows: 'T1', domains: 'T3', decisions: 'T3' },
        },
    }
}

/**
 * System-store config: an ordinary store whose freshness anchors to the launcher repo and
 * whose `map` runs the compose collector.
 * @param {ReturnType<typeof planWorkspace>} plan
 * @returns {object}
 */
export function systemConfig(plan) {
    const s = plan.systemStore
    return {
        schema: 1,
        project: {
            id: s.id,
            repo: plan.conductorRepo,
            remote: null,
            mainBranch: detectMainBranch(s.anchorRepo),
            anchorRepo: s.anchorRepo,
        },
        assurance: { level: 2 },
        language: 'en',
        map: { collectors: ['composemap'], composeFile: s.composeFile },
        sources: {},
        runtime: {},
        tickets: { pattern: plan.ticketPattern, mcp: null, readOnly: true },
        collectors: { default: ['codebase', 'user-input'], onDemand: [] },
        trust: {
            sourceOverrides: {},
            categoryFloors: { map: 'T0', flows: 'T1', domains: 'T3', decisions: 'T3' },
        },
    }
}

/**
 * Generic git-invisible pointer text (CLAUDE.local.md), created ONLY when the file is
 * absent. Parametric — nothing instance-specific beyond what the manifest provides.
 * @param {ReturnType<typeof planWorkspace>} plan
 * @param {{member?: string, conductor?: boolean}} [who]
 * @returns {string}
 */
export function workspacePointerText(plan, { member, conductor = false } = {}) {
    const lines = [
        '# Workspace pointer (generated by `kaut workspace init`; git-invisible via .git/info/exclude)',
        '',
        conductor
            ? `This is the CONDUCTOR repo of the "${plan.name}" workspace; its KAUT lookups serve the workspace SYSTEM store (services map, contracts, flows, runbook).`
            : `This repo ("${member}") is a member of the "${plan.name}" workspace.`,
        '',
        '- KAUT lookup (read BEFORE re-deriving knowledge from code): from the repo root run',
        '  `node ~/.kaut/engine/kaut.mjs lookup` (catalog) or `lookup <id>` (one doc).',
        `- Cross-repo / infrastructure questions — which service owns X, who talks to whom,`,
        `  where to look — are answered by the workspace system store; ask from the conductor`,
        `  repo: ${plan.conductorRepo}`,
        `- Workspace manifest (repos, roles, guards, flows): ${plan.conductorRepo}/manifest.json`,
        '',
    ]
    return lines.join('\n')
}

/**
 * Idempotently add entries to a repo's `.git/info/exclude` (never the committed
 * .gitignore — the team repo stays byte-identical).
 * @param {string} repoPath repo toplevel
 * @param {string[]} entries file names to exclude
 * @returns {boolean} true when the file changed
 * @throws {WorkspaceError} when the git common dir cannot be resolved
 */
export function ensureExcludeEntries(repoPath, entries) {
    const commonDir = tryGit(['rev-parse', '--path-format=absolute', '--git-common-dir'], repoPath)
    if (!commonDir) throw new WorkspaceError(`cannot resolve git common dir for ${repoPath}`)
    const excludeFile = path.join(commonDir, 'info', 'exclude')
    const have = existsSync(excludeFile) ? readFileSync(excludeFile, 'utf8').split('\n') : []
    const missing = entries.filter((e) => !have.includes(e))
    if (missing.length === 0) return false
    mkdirSync(path.dirname(excludeFile), { recursive: true })
    writeFileSync(excludeFile, [...have.filter((l, i) => l !== '' || i < have.length - 1), ...missing, ''].join('\n'))
    return true
}

/**
 * All registries (for `workspace list`).
 * @param {string} [dir]
 * @returns {object[]}
 */
export function listWorkspaces(dir = workspacesDir()) {
    clearRegistryCache() // list reads fresh from disk, never a stale cache
    return loadRegistries(dir)
}
