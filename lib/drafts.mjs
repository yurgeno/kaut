/**
 * Draft queue — the asynchronous half of the owner gate.
 *
 * Problem measured 2026-08-25: the owner gate alone is SYNCHRONOUS (`index --approve` needs the
 * owner in the session), so a session that re-derived an owner-tier doc and found no owner
 * present simply dropped the work — the store rotted while the knowledge evaporated. The
 * queue converts the gate to asynchronous: the session parks a finished update as a DRAFT;
 * the owner reviews the accumulated batch in one sitting (`kaut review`).
 *
 * Placement: `<store>/.drafts/<id>.md`, mirroring the layer tree. `.drafts` is NOT a layer
 * dir, so by construction it is invisible to INDEX/lookup/stale/doctor doc scans (scanStore
 * walks LAYER_DIRS only) and exempt from the layer write gate (grants gate only layer docs) —
 * an agent can commit a draft in ANY layer without `--approve`, and the draft is never
 * served to a reader. Drafts are committed through the ordinary chokepoint, so the store
 * stays tamper-clean and the queue is durable + auditable in store git history.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs'
import path from 'node:path'

export const DRAFTS_DIR = '.drafts'

/**
 * @param {string} root store root
 * @param {string} id doc id (layer-relative, no .md)
 * @returns {string} absolute draft path
 */
export function draftPath(root, id) {
    return path.join(root, DRAFTS_DIR, `${id}.md`)
}

/**
 * Pending draft ids, sorted (the review queue).
 * @param {string} root store root
 * @returns {string[]}
 */
export function listDrafts(root) {
    const base = path.join(root, DRAFTS_DIR)
    if (!existsSync(base)) return []
    /** @type {string[]} */
    const out = []
    const walk = (dir) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, entry.name)
            if (entry.isDirectory()) walk(p)
            else if (entry.name.endsWith('.md')) out.push(path.relative(base, p).replace(/\.md$/, ''))
        }
    }
    walk(base)
    return out.sort()
}

/**
 * Read a pending draft's raw content.
 * @param {string} root
 * @param {string} id
 * @returns {string|null} null when no such draft
 */
export function readDraft(root, id) {
    const p = draftPath(root, id)
    return existsSync(p) ? readFileSync(p, 'utf8') : null
}

/**
 * Promote a draft into its layer position (approve). Caller runs index + commitAll with
 * `approve: true` afterwards — promotion itself is a plain move; the gate still decides.
 * @param {string} root
 * @param {string} id
 */
export function promoteDraft(root, id) {
    const from = draftPath(root, id)
    const to = path.join(root, `${id}.md`)
    mkdirSync(path.dirname(to), { recursive: true })
    renameSync(from, to)
}

/**
 * Remove a pending draft (reject). Caller commits.
 * @param {string} root
 * @param {string} id
 */
export function removeDraft(root, id) {
    rmSync(draftPath(root, id))
}
