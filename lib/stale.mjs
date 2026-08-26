/**
 * Freshness / verdict engine (SCHEMA §11).
 *
 * The error-asymmetry law governs every branch here: when forced to choose, err toward
 * `stale` (a cheap re-check), never toward fresh (silent corruption).
 *
 * Verdicts are computed at read time and never stored (except `disputed`, an optional
 * frontmatter flag written by Phase 2+). Exactly one verdict renders, by priority
 * `tampered > disputed > broken > stale > branch-advisory` (`tampered` is a store-side
 * verdict applied by the CLI — see VERDICT below):
 *
 *   broken           — a file-typed source matches ZERO paths in the anchor tree (renames/typos);
 *                      the doc cannot be freshness-checked until its sources are re-bound.
 *   stale            — `git diff derived..anchor` over the file sources is non-empty, OR the
 *                      derivation commit is unknown / not on the main line (D4). A commit that is
 *                      ahead of the anchor but still on the main line (an old branch read alongside a
 *                      freshly-distilled doc) is NOT stale — only divergent/unreachable derivations
 *                      err toward stale.
 *   branch-advisory  — ephemeral: the current branch or working tree modifies the sources;
 *                      computed fresh at read, never persisted (so stored status never flaps
 *                      when you switch branches — the merge-base anchor is branch-independent).
 *
 * The anchor is `merge-base(HEAD, <main>)`, so a doc's stored verdict depends only on what has
 * reached the shared main line, not on the branch you happen to be standing on.
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { tryGit } from './discover.mjs'
import { anyMatch, filterMatch } from './glob.mjs'
import { parseFrontmatter } from './frontmatter.mjs'
import { resolveRepoPath } from './registry.mjs'
import { parseSections } from './sections.mjs'
import { FILE_TYPES, parseSources } from './sources.mjs'
import { scanStore, validateDoc } from './indexgen.mjs'

/** Verdict identifiers. */
export const VERDICT = {
    HEALTHY: 'healthy',
    // Outranks everything. Computed by the CLI from STORE git state (an uncommitted /
    // out-of-pipeline edit to the doc file), not by this project-repo diff engine. A tampered
    // doc's content — frontmatter included — is untrusted and withheld from lookup entirely
    // (injection containment, engine v0.2.1).
    TAMPERED: 'tampered',
    DISPUTED: 'disputed',
    BROKEN: 'broken',
    STALE: 'stale',
    ADVISORY: 'branch-advisory',
}

/** Worst-wins priority (index 0 = worst). A doc's verdict is the worst across its units. */
const PRIORITY = [VERDICT.DISPUTED, VERDICT.BROKEN, VERDICT.STALE, VERDICT.ADVISORY, VERDICT.HEALTHY]

/**
 * Resolve the freshness anchor.
 * `mainRef` = `origin/<main>` when it exists, else local `<main>`, else `HEAD` (solo/degenerate).
 * `anchor` = `merge-base(HEAD, mainRef)`, falling back to `HEAD` when merge-base cannot be
 * computed (shallow clone, unrelated histories) — err-toward-stale handles the rest downstream.
 * @param {string} repo repo toplevel
 * @param {string} mainBranch e.g. "master"
 * @returns {{anchor: string|null, mainRef: string}}
 */
export function resolveAnchor(repo, mainBranch) {
    let mainRef
    if (tryGit(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${mainBranch}`], repo) !== null)
        mainRef = `origin/${mainBranch}`
    else if (tryGit(['rev-parse', '--verify', '--quiet', `refs/heads/${mainBranch}`], repo) !== null)
        mainRef = mainBranch
    else mainRef = 'HEAD'
    const anchor = tryGit(['merge-base', 'HEAD', mainRef], repo) ?? tryGit(['rev-parse', 'HEAD'], repo)
    return { anchor, mainRef }
}

/**
 * Split git's newline-separated path output into clean entries. Safe against `tryGit`'s
 * trimming because these commands emit plain paths with no status-column prefix (unlike
 * `git status --porcelain`, whose leading space would be eaten by the trim).
 * @param {string|null} out
 * @returns {string[]}
 */
function lines(out) {
    return (out || '').split('\n').filter(Boolean)
}

/**
 * Build a reusable evaluation context: resolves the anchor once, precomputes the ephemeral
 * branch-changed set once, and lazily loads the anchor tree (only when a broken check needs it).
 * @param {string} repo repo toplevel
 * @param {string} mainBranch
 * @returns {{repo: string, anchor: string|null, mainRef: string, branch: string,
 *   branchChanged: Set<string>, anchorTree: () => Set<string>, changedTo: (derived: string) => string[]}}
 */
export function createContext(repo, mainBranch) {
    const { anchor, mainRef } = resolveAnchor(repo, mainBranch)
    const branch = tryGit(['rev-parse', '--abbrev-ref', 'HEAD'], repo) ?? 'HEAD'

    // Ephemeral branch advisory input: committed changes since the anchor, plus uncommitted
    // edits (tracked modifications staged or not, and untracked files).
    const branchChanged = new Set()
    if (anchor) for (const f of lines(tryGit(['diff', '--no-renames', '--name-only', `${anchor}..HEAD`], repo))) branchChanged.add(f)
    for (const f of lines(tryGit(['diff', '--no-renames', '--name-only', 'HEAD'], repo))) branchChanged.add(f)
    for (const f of lines(tryGit(['ls-files', '--others', '--exclude-standard'], repo))) branchChanged.add(f)

    /** @type {Set<string>|null} */
    let tree = null
    const anchorTree = () => {
        if (tree) return tree
        tree = new Set()
        if (anchor) for (const f of lines(tryGit(['ls-tree', '-r', '--name-only', anchor], repo))) tree.add(f)
        return tree
    }

    /** @type {Map<string, string[]>} cache: derived sha → changed files derived..anchor */
    const diffCache = new Map()
    const changedTo = (derived) => {
        if (diffCache.has(derived)) return /** @type {string[]} */ (diffCache.get(derived))
        const out = anchor ? lines(tryGit(['diff', '--no-renames', '--name-only', `${derived}..${anchor}`], repo)) : []
        diffCache.set(derived, out)
        return out
    }

    return { repo, anchor, mainRef, branch, branchChanged, anchorTree, changedTo }
}

/**
 * Evaluate one set of sources against the context.
 * @param {string[]} rawSources typed source strings
 * @param {string} derived derivation commit of the owning doc
 * @param {ReturnType<typeof createContext>} ctx
 * @param {boolean} [freshnessApplies] when false, skip the file-source freshness diff (the doc was
 *   derived ahead of the anchor but on the main line — fresh vs. the anchor); broken + branch-advisory
 *   + repo-existence checks still run.
 * @returns {{broken: string[], stale: string[], advisory: string[]}}
 *   broken — file patterns matching nothing in the anchor tree;
 *   stale/advisory — offending file paths.
 */
function evaluateSources(rawSources, derived, ctx, freshnessApplies = true) {
    const { sources } = parseSources(rawSources)
    const fileSources = sources.filter((s) => FILE_TYPES.has(s.type))
    const repoSources = sources.filter((s) => s.type === 'repo')
    const broken = []
    const stale = new Set()
    const advisory = new Set()
    const notes = []

    if (fileSources.length === 0 && repoSources.length === 0)
        return { broken: [], stale: [], advisory: [], notes } // provenance-only: never stale/broken

    if (fileSources.length) {
        const tree = ctx.anchorTree()
        for (const s of fileSources) {
            const pattern = /** @type {string} */ (s.filePath)
            // broken: the pattern resolves to no real file at the anchor (rename/typo).
            if (!anyMatch(pattern, tree)) {
                broken.push(s.raw)
                continue // a broken pattern cannot meaningfully be diffed
            }
            if (freshnessApplies) for (const f of filterMatch(pattern, ctx.changedTo(derived))) stale.add(f)
            for (const f of filterMatch(pattern, ctx.branchChanged)) advisory.add(f)
        }
    }

    // repo:<name>:file:<path> (v0.3.0) — existence-only at the member repo's HEAD, resolved
    // via the workspace registry; full multi-anchor staleness is post-pilot. An unresolvable
    // registry/repo cannot be verified → err toward stale, never toward fresh.
    for (const s of repoSources) {
        const repoPath = resolveRepoPath(/** @type {string} */ (s.repoName))
        if (!repoPath || !existsSync(repoPath)) {
            stale.add(s.raw)
            notes.push(`repo source "${s.raw}" unverifiable (workspace registry/repo missing) — treating as stale`)
            continue
        }
        if (tryGit(['cat-file', '-e', `HEAD:${s.repoFile}`], repoPath) === null) broken.push(s.raw)
    }
    return { broken, stale: [...stale], advisory: [...advisory], notes }
}

/**
 * Compute the verdict for one parsed document.
 * @param {{fields: Record<string, string|string[]>, body: string}} doc parsed frontmatter + body
 * @param {ReturnType<typeof createContext>} ctx
 * @returns {{verdict: string, affected: string[], notes: string[],
 *   sections: Array<{heading: string, verdict: string, affected: string[]}>}}
 */
export function verdictForDoc(doc, ctx) {
    const f = doc.fields
    const notes = []

    if (f.disputed === 'true' || f.disputed === true)
        return { verdict: VERDICT.DISPUTED, affected: [], notes, sections: [] }

    const derived = String(f.derived_from_commit)
    const docSources = /** @type {string[]} */ (Array.isArray(f.sources) ? f.sources : [])

    // D4 err-toward-stale: an unknown or non-ancestor derivation commit cannot be diffed safely.
    if (!ctx.anchor) {
        notes.push('anchor unresolved (no merge-base) — treating as stale')
        return { verdict: VERDICT.STALE, affected: [], notes, sections: [] }
    }
    const known = tryGit(['rev-parse', '--verify', '--quiet', `${derived}^{commit}`], ctx.repo) !== null
    if (!known) {
        notes.push('derivation commit not in repo — treating as stale')
        return { verdict: VERDICT.STALE, affected: [], notes, sections: [] }
    }
    const isAncestor = tryGit(['merge-base', '--is-ancestor', derived, ctx.anchor], ctx.repo) !== null
    let freshnessApplies = true
    if (!isAncestor) {
        // derived is ahead of / off the branch's anchor. If it is still on the MAIN line (an ancestor
        // of mainRef), the doc was simply distilled from a newer main commit than this branch's fork
        // point — e.g. an old ticket branch read alongside a freshly-distilled doc — so it is FRESH
        // relative to the anchor, not stale (the false-stale defect). Skip the freshness diff but keep
        // broken + branch-advisory. Only a derivation NOT on the main line (a divergent or unreachable
        // commit) keeps err-toward-stale — the case the asymmetry law is actually for.
        const onMainLine = tryGit(['merge-base', '--is-ancestor', derived, ctx.mainRef], ctx.repo) !== null
        if (!onMainLine) {
            notes.push('derivation commit not in main history (ahead of or off the anchor) — treating as stale')
            return { verdict: VERDICT.STALE, affected: [], notes, sections: [] }
        }
        notes.push('derivation commit is ahead of this branch’s anchor but on the main line — fresh vs. anchor')
        freshnessApplies = false
    }

    // Evaluation units: the doc-level sources as a baseline, plus every section that declares
    // its own bindings (a section without bindings inherits the doc-level sources, already
    // covered by the baseline). Doc verdict = worst unit; affected = union.
    const { sections } = parseSections(doc.body)
    /** @type {Array<{heading: string, sources: string[]}>} */
    const units = [{ heading: '(doc)', sources: docSources }]
    for (const s of sections) if (s.sources.length) units.push({ heading: s.heading, sources: s.sources })

    const brokenAll = new Set()
    const staleAll = new Set()
    const advisoryAll = new Set()
    /** @type {Array<{heading: string, verdict: string, affected: string[]}>} */
    const sectionVerdicts = []

    for (const u of units) {
        const r = evaluateSources(u.sources, derived, ctx, freshnessApplies)
        r.broken.forEach((x) => brokenAll.add(x))
        r.stale.forEach((x) => staleAll.add(x))
        r.advisory.forEach((x) => advisoryAll.add(x))
        for (const n of r.notes) if (!notes.includes(n)) notes.push(n)
        const uv = r.broken.length ? VERDICT.BROKEN : r.stale.length ? VERDICT.STALE : r.advisory.length ? VERDICT.ADVISORY : VERDICT.HEALTHY
        if (u.heading !== '(doc)')
            sectionVerdicts.push({ heading: u.heading, verdict: uv, affected: [...r.broken, ...r.stale, ...r.advisory] })
    }

    if (brokenAll.size) return { verdict: VERDICT.BROKEN, affected: [...brokenAll], notes, sections: sectionVerdicts }
    if (staleAll.size) return { verdict: VERDICT.STALE, affected: [...staleAll], notes, sections: sectionVerdicts }
    if (advisoryAll.size) return { verdict: VERDICT.ADVISORY, affected: [...advisoryAll], notes, sections: sectionVerdicts }
    return { verdict: VERDICT.HEALTHY, affected: [], notes, sections: sectionVerdicts }
}

/**
 * Worst verdict among a list (helper for callers that aggregate).
 * @param {string[]} verdicts
 * @returns {string}
 */
export function worstVerdict(verdicts) {
    for (const v of PRIORITY) if (verdicts.includes(v)) return v
    return VERDICT.HEALTHY
}

/**
 * Compute verdicts for all valid docs in the store (or a selected subset of ids).
 * Invalid docs are reported with a null verdict and their validation errors — never dropped.
 * @param {string} root store root
 * @param {string} repo repo toplevel
 * @param {string} mainBranch
 * @param {string[]} [ids] optional subset of doc ids (without `.md`); default = all
 * @returns {Array<{id: string, trust: string|null, verdict: string|null, affected: string[], notes: string[], errors?: string[]}>}
 */
export function staleAll(root, repo, mainBranch, ids) {
    const ctx = createContext(repo, mainBranch)
    const want = ids ? new Set(ids) : null
    const out = []
    for (const rel of scanStore(root)) {
        const id = rel.replace(/\.md$/, '')
        if (want && !want.has(id)) continue
        const raw = readFileSync(path.join(root, rel), 'utf8')
        const v = validateDoc(rel, raw)
        if (!v.ok) {
            out.push({ id, trust: null, verdict: null, affected: [], notes: [], errors: v.errors })
            continue
        }
        const parsed = parseFrontmatter(raw)
        const r = verdictForDoc({ fields: v.fields, body: parsed.body }, ctx)
        out.push({ id, trust: String(v.fields.trust), verdict: r.verdict, affected: r.affected, notes: r.notes })
    }
    return out
}
