/**
 * Write grants — the layered promotion gate (the knowledge-update promotion design).
 *
 * Enforced at the single commit chokepoint (gitstore.commitAll), so it is non-bypassable by
 * choosing a different write command (bootstrap/index/map/workspace all funnel through commitAll).
 * Policy is DATA: a per-layer `writePolicy` map flows manifest → registry → here.
 *
 * Open-until-configured: a store with no registry entry, OR an entry with no `writePolicy`, OR a
 * layer the policy does not cover, grants the write (free — byte-identical to pre-gate behaviour).
 * A `storePolicy: do-not-touch` entry refuses ALL writes (absolute precedence). A changed doc whose
 * layer/provenance resolves to `owner` is refused unless `--approve` (an OWNER-RUN escape) is set.
 *
 * Creation-distinction (Mechanism A): an UPDATE to an existing agent-tier
 * doc, and the CREATION of a type that already exists elsewhere in the deployment, stay Tier A (auto).
 * Creating a NOVEL id — absent from this store's HEAD AND from every sibling store — upgrades to
 * owner-gated, capping agent-driven doc proliferation + naming drift. `map` is exempt: adapter map is
 * deterministic and provenance-gated (§3), a fixed id-set — not the agent-authoring drift this targets
 * (a hand-authored map is already `owner` via provenance).
 *
 * NOT enforced here: the Tier-A in-session-verification predicate (a Tier-A auto-write only when the
 * writing session runtime-verified the fact). The engine cannot prove in-session verification, so —
 * like all of distill — it is agent-side honor system (a HARD GATE in the session discipline), upheld by discipline +
 * reading-is-repair + doctor. This gate enforces ONLY the layer/provenance/do-not-touch policy and the
 * approval flag; it does not over-claim verification.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { tryGit } from './discover.mjs'
import { parseFrontmatter } from './frontmatter.mjs'
import { LAYER_DIRS, typeForId } from './indexgen.mjs'
import { deploymentSiblingStoreRoots, resolveWriteEntry, resolveWritePolicy } from './registry.mjs'

/** Refusal carrying the offending docs. Exit 1, nothing committed. */
export class GrantError extends Error {
    /**
     * @param {string} message
     * @param {Array<{id: string, tier: string}>} refused
     */
    constructor(message, refused) {
        super(message)
        this.code = 'KAUT_GRANT'
        this.refused = refused
    }
}

const LAYER_SET = new Set(LAYER_DIRS)

/** True when a store-relative path is a fact doc under a layer dir. */
function isLayerDoc(rel) {
    return rel.endsWith('.md') && LAYER_SET.has(rel.split('/')[0])
}

/** The doc's `engine:` provenance, '' when the file is unreadable/deleted (handled conservatively). */
function provenanceOf(root, rel) {
    try {
        const f = parseFrontmatter(readFileSync(path.join(root, rel), 'utf8')).fields
        return typeof f.engine === 'string' ? f.engine : ''
    } catch {
        return ''
    }
}

/** Store-relative paths committed in the store's HEAD (empty when the store has no commits yet). */
function headPaths(root) {
    const out = tryGit(['ls-tree', '-r', 'HEAD', '--name-only'], root)
    return new Set(out ? out.split('\n').filter(Boolean) : [])
}

/** True when `id` is a COMMITTED doc in at least one sibling store (an established deployment type). */
function idExistsInDeployment(siblingRoots, id) {
    const ref = `HEAD:${id}.md`
    // committed ground truth: a sibling's uncommitted draft is not an established pattern. tryGit
    // returns '' on success (object present) and null on a non-zero exit (absent / no HEAD).
    for (const sib of siblingRoots) if (tryGit(['cat-file', '-e', ref], sib) !== null) return true
    return false
}

/**
 * Enforce the write grants for the set of paths about to be committed.
 * @param {string} root store root
 * @param {Iterable<string>} changedPaths store-relative paths (working-tree diff vs HEAD + untracked)
 * @param {{approve?: boolean}} [opts]
 * @returns {Array<{id: string, tier: string}>} granted docs (for the audit journal)
 * @throws {GrantError} when any changed doc is refused
 */
export function enforceGrants(root, changedPaths, { approve = false } = {}) {
    const entry = resolveWriteEntry(root)
    if (!entry) return [] // no registry knows this store → ungoverned free write (single-store, tests)

    const changed = [...changedPaths]
    // do-not-touch: absolute precedence — a gated store takes no pipeline write at all, even agent-tier.
    if (typeof entry.storePolicy === 'string' && entry.storePolicy.startsWith('do-not-touch')) {
        if (!changed.length) return []
        throw new GrantError(
            'store is do-not-touch — no pipeline write allowed',
            changed.map((p) => ({ id: p.replace(/\.md$/, ''), tier: 'do-not-touch' })),
        )
    }

    const docs = changed.filter(isLayerDoc)
    if (!docs.length) return []

    let head = null // store HEAD paths — resolved on first agent-tier doc (lazy: owner-only commits pay no git)
    let siblings = null // sibling store roots — resolved on first agent-tier CREATE
    const refused = []
    const granted = []
    for (const rel of docs) {
        const id = rel.replace(/\.md$/, '')
        const layer = typeForId(id)
        let tier = resolveWritePolicy(entry, layer, provenanceOf(root, rel))
        // Creation-distinction (Mechanism A): a novel agent-tier creation upgrades to owner-gated.
        // map is exempt — adapter map is deterministic/provenance-gated (§3), not authoring drift.
        if (tier === 'agent' && layer !== 'map') {
            if (head === null) head = headPaths(root)
            if (!head.has(rel)) {
                // a local creation — Tier A only if the id is an established type elsewhere in the deployment
                if (siblings === null) siblings = deploymentSiblingStoreRoots(root)
                if (!idExistsInDeployment(siblings, id)) tier = 'owner'
            }
        }
        if (tier === 'owner' && !approve) refused.push({ id, tier: 'owner' })
        else granted.push({ id, tier: tier === 'owner' ? 'owner-approved' : (tier ?? 'free') })
    }
    if (refused.length) {
        throw new GrantError(
            `write refused — owner-gated docs need --approve: ${refused.map((r) => r.id).join(', ')}`,
            refused,
        )
    }
    return granted
}
