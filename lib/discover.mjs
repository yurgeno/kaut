/**
 * KAUT engine — store/engine discovery.
 *
 * Resolution chain: KAUT_ROOT env → `<repo>/.kaut.json` pointer → derivation from the
 * normalized origin remote URL (or the main-checkout path when the repo has no remote).
 * Same remote ⇒ same project id ⇒ clones and worktrees of one project share one store
 * by design (D2).
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

/**
 * The fixed anchor directory (`~/.kaut`): a small well-known location that holds the
 * engine checkout by convention and the OPTIONAL data-home redirect written by
 * `kaut home <dir>` (the engine's own install step — where knowledge lives is KAUT's
 * knowledge, no caller has to pass an env for it).
 * @returns {string}
 */
export function kautAnchor() {
    return path.join(homedir(), '.kaut')
}

/**
 * Base directory for the knowledge DATA KAUT keeps outside project repos (stores,
 * workspace registry). Resolution: `KAUT_HOME` env (tests; one-off overrides) → the
 * `dataRoot` redirect in `<anchor>/config.json` (set via `kaut home <dir>`) → the
 * anchor itself (`~/.kaut`, the historical default).
 * @param {Record<string, string|undefined>} [env]
 * @returns {string}
 */
export function kautHome(env = process.env) {
    if (env.KAUT_HOME) return env.KAUT_HOME
    try {
        const cfg = JSON.parse(readFileSync(path.join(kautAnchor(), 'config.json'), 'utf8'))
        if (typeof cfg?.dataRoot === 'string' && cfg.dataRoot) return cfg.dataRoot
    } catch {
        // no redirect / unreadable — the default applies; `kaut home` surfaces the state
    }
    return kautAnchor()
}

/** Per-store config file name. */
export const CONFIG_NAME = 'kaut.config.json'

/**
 * Resolve the store config path.
 * @param {string} root store root
 * @returns {string} absolute config path
 */
export function storeConfigPath(root) {
    return path.join(root, CONFIG_NAME)
}

/** Error class mapped to CLI exit code 3 ("environment missing"). */
export class EnvironmentError extends Error {
    /** @param {string} message */
    constructor(message) {
        super(message)
        this.code = 'KAUT_ENV'
    }
}

/**
 * Run git and return trimmed stdout, or null when the command fails.
 * Used for probes where absence (no remote, no ref) is a normal answer.
 * @param {string[]} args git arguments
 * @param {string} cwd working directory
 * @returns {string|null}
 */
export function tryGit(args, cwd) {
    try {
        // quotepath=false: git C-quotes non-ASCII paths by default ("r\303\251sum\303\251.ts"),
        // which breaks every set-membership comparison against real path strings downstream
        // (tamper withhold, grant gate, freshness matching). Raw bytes, always.
        return execFileSync('git', ['-c', 'core.quotepath=false', ...args], {
            cwd,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
        }).trim()
    } catch {
        return null
    }
}

/**
 * Resolve the git toplevel for a directory.
 * @param {string} cwd
 * @returns {string} absolute toplevel path
 * @throws {EnvironmentError} when cwd is not inside a git repository
 */
export function repoToplevel(cwd) {
    const top = tryGit(['rev-parse', '--show-toplevel'], cwd)
    if (!top) throw new EnvironmentError(`not a git repository: ${cwd}`)
    return top
}

/**
 * Normalize a git remote URL so that https/ssh/scp spellings of the same remote produce
 * the same key: lowercase, scheme and credentials stripped, scp-style `host:path` unified
 * to `host/path`, trailing `.git` and slashes removed.
 * E.g. `git@host:grp/repo.git` and `https://host/grp/repo` → `host/grp/repo`.
 * @param {string} url
 * @returns {string}
 */
export function normalizeRemoteUrl(url) {
    let u = url.trim().toLowerCase()
    u = u.replace(/^[a-z+]+:\/\//, '') // scheme://
    u = u.replace(/^[^@/]+@/, '') // user[:password]@ (also covers scp-like git@host:path)
    u = u.replace(':', '/') // scp-like host:path → host/path
    u = u.replace(/\.git$/, '')
    u = u.replace(/\/+$/, '')
    return u
}

/**
 * Last path segment of a normalized key, sanitized to [a-z0-9_-] for filesystem use.
 * @param {string} key
 * @returns {string}
 */
function basenameOf(key) {
    const seg = key.split('/').filter(Boolean).pop() || 'project'
    return seg.replace(/[^a-z0-9_-]+/gi, '-').toLowerCase()
}

/**
 * Derive the deterministic project id `<basename>--<sha256(key)[0..8]>` (D2).
 * Key = normalized remote URL; with no remote, the main-checkout path (worktree-safe via
 * `--git-common-dir`, so every worktree resolves to the same id).
 * @param {string} repoRoot absolute repo toplevel
 * @returns {string}
 */
export function deriveProjectId(repoRoot) {
    const remote = tryGit(['remote', 'get-url', 'origin'], repoRoot)
    let key
    if (remote) {
        key = normalizeRemoteUrl(remote)
    } else {
        const common = tryGit(['rev-parse', '--path-format=absolute', '--git-common-dir'], repoRoot)
        key = path.dirname(common ?? path.join(repoRoot, '.git'))
    }
    const hash8 = createHash('sha256').update(key).digest('hex').slice(0, 8)
    return `${basenameOf(key)}--${hash8}`
}

/**
 * Detect the project's main branch: origin/HEAD → local master → local main → 'master'.
 * Recorded in config as project.mainBranch (Phase 1 merge-base logic will need it).
 * @param {string} repoRoot
 * @returns {string}
 */
export function detectMainBranch(repoRoot) {
    const head = tryGit(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], repoRoot)
    if (head) return head.replace(/^origin\//, '')
    if (tryGit(['show-ref', '--verify', 'refs/heads/master'], repoRoot) !== null) return 'master'
    if (tryGit(['show-ref', '--verify', 'refs/heads/main'], repoRoot) !== null) return 'main'
    return 'master'
}

/**
 * Freshness-anchoring repo for a store (engine v0.3.0, additive). A store config may
 * declare `project.anchorRepo` — an absolute path to the repo whose git history anchors
 * the store's freshness (e.g. a workspace SYSTEM store anchored to the launcher repo while
 * being read from the conductor repo). Absent key (every pre-0.3.0 store) → the cwd repo:
 * exactly the old behavior, byte-identical. An unresolvable anchorRepo degrades downstream
 * to err-toward-stale (tryGit returns nulls → anchor unresolved → stale verdicts).
 * @param {{root: string, repo: string, mainBranch: string}} d discovery result
 * @returns {{repo: string, mainBranch: string}}
 */
export function resolveFreshnessRepo(d) {
    try {
        const cfg = JSON.parse(readFileSync(storeConfigPath(d.root), 'utf8'))
        const anchor = cfg?.project?.anchorRepo
        if (typeof anchor === 'string' && anchor && anchor !== d.repo)
            return { repo: anchor, mainBranch: detectMainBranch(anchor) }
    } catch {
        // no config yet / unparsable — doctor surfaces config problems; freshness falls
        // back to the cwd repo
    }
    return { repo: d.repo, mainBranch: d.mainBranch }
}

/**
 * Resolve everything the CLI needs. Injectable cwd/env keep this testable.
 * A malformed pointer file is ignored here (derivation still resolves the same store);
 * `doctor` is the place that surfaces pointer disagreement.
 * @param {{cwd?: string, env?: Record<string, string|undefined>}} [opts]
 * @returns {{projectId: string, root: string, engine: string, repo: string, mainBranch: string, source: 'env'|'pointer'|'derived'}}
 */
export function discover({ cwd = process.cwd(), env = process.env } = {}) {
    const repo = repoToplevel(cwd)
    let pointer = null
    const pointerPath = path.join(repo, '.kaut.json')
    if (existsSync(pointerPath)) {
        try {
            pointer = JSON.parse(readFileSync(pointerPath, 'utf8'))
        } catch {
            pointer = null
        }
    }
    let root
    let source
    if (env.KAUT_ROOT) {
        root = env.KAUT_ROOT
        source = 'env'
    } else if (pointer?.root) {
        root = pointer.root
        source = 'pointer'
    } else {
        root = path.join(kautHome(env), deriveProjectId(repo))
        source = 'derived'
    }
    const engine = env.KAUT_ENGINE || pointer?.engine || path.join(kautAnchor(), 'engine')
    const projectId =
        source === 'pointer' && pointer?.projectId ? pointer.projectId : path.basename(root)
    return { projectId, root, engine, repo, mainBranch: detectMainBranch(repo), source }
}
