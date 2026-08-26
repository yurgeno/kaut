/**
 * Store git helpers (SCHEMA §8).
 *
 * The store is its own private git repository: no remote, repo-local identity
 * `KAUT <kaut@local>` so engine commits are distinguishable from human edits, gpg signing
 * disabled (a global commit.gpgsign=true must not break headless commits).
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { tryGit } from './discover.mjs'
import { enforceGrants } from './grants.mjs'
import { appendJournal } from './journal.mjs'

/**
 * Run git inside the store. Throws on failure — store git must never fail silently.
 * @param {string} root store root
 * @param {string[]} args
 * @returns {string} trimmed stdout
 */
export function storeGit(root, args) {
    // quotepath=false for the same reason as tryGit: path output must be comparable raw bytes.
    return execFileSync('git', ['-c', 'core.quotepath=false', ...args], { cwd: root, encoding: 'utf8' }).trim()
}

/**
 * Ensure the store is a git repository with the KAUT identity. Idempotent — config set
 * calls converge to the same state on every run.
 * @param {string} root
 * @returns {boolean} true when a brand-new repo was created
 */
export function ensureStoreGit(root) {
    const created = !existsSync(path.join(root, '.git'))
    if (created) storeGit(root, ['init', '--quiet'])
    storeGit(root, ['config', 'user.name', 'KAUT'])
    storeGit(root, ['config', 'user.email', 'kaut@local'])
    storeGit(root, ['config', 'commit.gpgsign', 'false'])
    return created
}

/**
 * Stage everything and commit when the tree is dirty. The single write chokepoint — EVERY engine
 * write path (bootstrap/index/map/workspace) funnels through here, so the write-grant gate sits
 * here and cannot be bypassed by choosing a different command. enforceGrants throws GrantError when a
 * changed doc is owner-gated without `approve` (nothing is staged or committed); granted docs are
 * journalled (`op:'write'`) after the commit. With no registry / no writePolicy the gate is inert
 * (open-until-configured — byte-identical to pre-gate behaviour).
 * @param {string} root
 * @param {string} message commit message (`kaut: <op> <detail>` convention)
 * @param {{approve?: boolean}} [opts] approve = the owner-run escape for owner-tier doc writes
 * @returns {boolean} true when a commit was made
 * @throws {import('./grants.mjs').GrantError} when a changed doc is refused
 */
export function commitAll(root, message, { approve = false } = {}) {
    const granted = enforceGrants(root, uncommittedPaths(root), { approve }) // pre-stage; throws on refusal
    storeGit(root, ['add', '-A'])
    if (!storeGit(root, ['status', '--porcelain'])) return false
    // Record an owner approval durably in store git history (the audit + rollback surface).
    const approved = granted.filter((g) => g.tier === 'owner-approved').map((g) => g.id)
    const msg = approved.length ? `${message} [owner-approved: ${approved.join(', ')}]` : message
    storeGit(root, ['commit', '--quiet', '-m', msg])
    for (const g of granted) appendJournal(root, { op: 'write', topic: g.id, tier: g.tier })
    return true
}

/**
 * @param {string} root
 * @returns {string} `git status --porcelain` output ('' = clean)
 */
export function storeStatus(root) {
    return storeGit(root, ['status', '--porcelain'])
}

/**
 * Store-relative paths whose content differs from the last KAUT commit: tracked files
 * modified vs HEAD (staged or not) plus untracked files. Every byte the read path serves
 * must come from a KAUT commit — anything listed here is an out-of-pipeline edit and is
 * withheld by lookup as `tampered` (engine v0.2.1; SCHEMA §16).
 *
 * Column-free git output on purpose: `status --porcelain` columns do not survive tryGit's
 * trim (the leading-space ' M' bug — see stale.mjs lines()). tryGit (not storeGit) so a
 * store without commits yet degrades to "everything untracked = withheld", not a throw.
 * @param {string} root store root
 * @returns {Set<string>} store-relative paths
 */
export function uncommittedPaths(root) {
    const out = new Set()
    // --no-renames: a staged rename otherwise lists only the NEW path, hiding the old doc's
    // disappearance from both the tamper withhold and the grant gate.
    for (const args of [
        ['diff', '--no-renames', '--name-only', 'HEAD'],
        ['ls-files', '--others', '--exclude-standard'],
    ]) {
        const res = tryGit(args, root)
        if (res) for (const f of res.split('\n')) if (f) out.add(f)
    }
    return out
}
