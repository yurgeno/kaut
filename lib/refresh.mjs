/**
 * Refresh bundles — the delta side of re-derivation (the data half of the maintenance loop).
 *
 * `kaut refresh` computes, per doc, everything an agent needs to re-derive it CORRECTLY:
 * the target ref to anchor to (the tracked main line's TIP — never the working-tree HEAD,
 * the branch-anchored-draft lesson), the file sources that changed derived→target with
 * their git status, the sections whose bindings those files hit, and dead patterns that
 * need re-binding. The engine stays LLM-free: it hands over the delta, the agent rewrites
 * prose, the write gate (index / draft+review) lands it.
 *
 * Anchor triage (the wrong-repo-anchor defect class, found in the wild 2026-08-25 — two
 * system-store docs were harvested with a member repo's commit instead of the anchorRepo's):
 *   wrong-repo-anchor — derived_from_commit is not a commit of the freshness repo at all;
 *                       the per-file diff is meaningless → full re-derive against target.
 *   off-main-anchor   — the commit exists but is not on the main line (branch-anchored);
 *                       same consequence: full re-derive against target.
 * Both statuses carry the same directive; they differ only in what went wrong at harvest.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { tryGit } from './discover.mjs'
import { anyMatch, filterMatch } from './glob.mjs'
import { parseFrontmatter } from './frontmatter.mjs'
import { parseSections } from './sections.mjs'
import { FILE_TYPES, parseSources } from './sources.mjs'
import { scanStore, validateDoc } from './indexgen.mjs'
import { resolveAnchor } from './stale.mjs'
import { resolveRepoPath } from './registry.mjs'

/** Refresh row statuses. */
export const REFRESH = {
    CURRENT: 'current', // no source drift derived→target: nothing to re-derive
    DELTA: 'delta', // sources changed: re-derive the flagged parts
    MECHANICAL: 'mechanical', // adapter-generated map — regenerate, never hand-rewrite
    WRONG_REPO: 'wrong-repo-anchor',
    OFF_MAIN: 'off-main-anchor',
    INVALID: 'invalid',
}

/** Adapter provenance prefixes — docs the `kaut map` collectors own. */
const ADAPTER_ENGINES = ['route-map@', 'pkg-graph@', 'compose-map@']

/**
 * The re-derivation instruction rendered into every non-current row. One sentence, stable
 * wording — skills quote it verbatim.
 * @param {string} target full sha to anchor to
 * @returns {string}
 */
function directiveFor(target) {
    return (
        `re-derive against ${target.slice(0, 12)} (read sources AT that ref, e.g. \`git show ${target.slice(0, 12)}:<path>\`); ` +
        `set derived_from_commit: ${target}; land via the write gate (agent layer → kaut index; owner layer → kaut draft + review --approve)`
    )
}

/**
 * Build refresh bundles for the store's docs.
 * @param {string} root store root
 * @param {string} repo freshness repo toplevel (anchorRepo-aware — caller resolves)
 * @param {string} mainBranch
 * @param {string[]} [ids] optional subset of doc ids; default = every doc in the store
 * @returns {{target: string|null, mainRef: string, rows: Array<{
 *   id: string, status: string, derived?: string, changed?: Array<{path: string, gitStatus: string}>,
 *   broken?: string[], repoBroken?: string[], sections?: Array<{heading: string, affected: string[]}>,
 *   notes: string[], directive?: string, errors?: string[]}>}}
 */
export function buildRefresh(root, repo, mainBranch, ids) {
    const { mainRef } = resolveAnchor(repo, mainBranch)
    // The refresh target is the main line's TIP — re-derivation must never anchor to a
    // branch or to the branch's merge-base (it would freeze already-superseded content).
    const target = tryGit(['rev-parse', mainRef], repo)
    const want = ids ? new Set(ids) : null
    /** @type {Map<string, string>|null} lazy: target tree paths (broken re-check) */
    let targetTree = null
    const treeAt = () => {
        if (targetTree) return targetTree
        targetTree = new Set()
        if (target) for (const f of (tryGit(['ls-tree', '-r', '--name-only', target], repo) || '').split('\n')) if (f) targetTree.add(f)
        return targetTree
    }

    const rows = []
    for (const rel of scanStore(root)) {
        const id = rel.replace(/\.md$/, '')
        if (want && !want.has(id)) continue
        const raw = readFileSync(path.join(root, rel), 'utf8')
        const v = validateDoc(rel, raw)
        if (!v.ok) {
            rows.push({ id, status: REFRESH.INVALID, notes: [], errors: v.errors })
            continue
        }
        const f = v.fields
        const engine = String(f.engine ?? '')
        if (ADAPTER_ENGINES.some((p) => engine.startsWith(p))) {
            rows.push({ id, status: REFRESH.MECHANICAL, notes: ['adapter-generated — run "kaut map" to regenerate'], directive: 'kaut map' })
            continue
        }
        if (!target) {
            rows.push({ id, status: REFRESH.INVALID, notes: [`cannot resolve ${mainRef} in ${repo}`], errors: ['target unresolvable'] })
            continue
        }

        const derived = String(f.derived_from_commit)
        const notes = []
        const known = tryGit(['rev-parse', '--verify', '--quiet', `${derived}^{commit}`], repo) !== null
        if (!known) {
            rows.push({
                id,
                status: REFRESH.WRONG_REPO,
                derived,
                notes: ['derivation commit not found in the anchor repo — wrong-repo anchor at harvest (or rewritten history); per-file diff impossible, re-derive fully'],
                directive: directiveFor(target),
            })
            continue
        }
        const onMain = tryGit(['merge-base', '--is-ancestor', derived, mainRef], repo) !== null
        if (!onMain) {
            rows.push({
                id,
                status: REFRESH.OFF_MAIN,
                derived,
                notes: ['derivation commit is not on the main line (branch-anchored harvest); re-derive fully'],
                directive: directiveFor(target),
            })
            continue
        }

        // Per-file delta derived→target, restricted to the doc's file-typed sources.
        /** @type {Map<string, string>} path → git status letter */
        const statusByPath = new Map()
        const diff = tryGit(['diff', '--no-renames', '--name-status', `${derived}..${target}`], repo) || ''
        for (const line of diff.split('\n')) {
            if (!line) continue
            const [st, ...rest] = line.split('\t')
            // renames: "R100\told\tnew" — record both ends so either pattern form matches
            if (st.startsWith('R') && rest.length === 2) {
                statusByPath.set(rest[0], 'D')
                statusByPath.set(rest[1], 'A')
            } else statusByPath.set(rest[rest.length - 1], st[0])
        }

        const docSources = /** @type {string[]} */ (Array.isArray(f.sources) ? f.sources : [])
        const { sections } = parseSections(parseFrontmatter(raw).body)
        /** @type {Array<{heading: string, sources: string[]}>} */
        const units = [{ heading: '(doc)', sources: docSources }]
        for (const s of sections) if (s.sources.length) units.push({ heading: s.heading, sources: s.sources })

        const changed = new Map() // path → status
        const broken = new Set()
        const repoBroken = new Set()
        /** @type {Array<{heading: string, affected: string[]}>} */
        const sectionRows = []
        for (const u of units) {
            const { sources } = parseSources(u.sources)
            const affected = new Set()
            for (const s of sources) {
                if (FILE_TYPES.has(s.type)) {
                    const pattern = /** @type {string} */ (s.filePath)
                    for (const p of filterMatch(pattern, statusByPath.keys())) {
                        changed.set(p, /** @type {string} */ (statusByPath.get(p)))
                        affected.add(p)
                    }
                    // dead at the TARGET tree = will be broken after re-anchoring — re-bind now
                    if (!anyMatch(pattern, treeAt())) broken.add(s.raw)
                } else if (s.type === 'repo') {
                    const repoPath = resolveRepoPath(/** @type {string} */ (s.repoName))
                    if (!repoPath || tryGit(['cat-file', '-e', `HEAD:${s.repoFile}`], repoPath) === null)
                        repoBroken.add(s.raw)
                }
            }
            if (u.heading !== '(doc)' && affected.size) sectionRows.push({ heading: u.heading, affected: [...affected] })
        }
        if (repoBroken.size) notes.push('repo: sources are existence-only (multi-anchor diff is post-pilot) — dead ones listed under repoBroken')

        const hasDelta = changed.size > 0 || broken.size > 0 || repoBroken.size > 0
        rows.push({
            id,
            status: hasDelta ? REFRESH.DELTA : REFRESH.CURRENT,
            derived,
            changed: [...changed].map(([p, st]) => ({ path: p, gitStatus: st })),
            broken: [...broken],
            repoBroken: [...repoBroken],
            sections: sectionRows,
            notes,
            ...(hasDelta ? { directive: directiveFor(target) } : {}),
        })
    }
    return { target, mainRef, rows }
}
