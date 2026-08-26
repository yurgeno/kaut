/**
 * Lookup block renderer (SCHEMA §12).
 *
 * Produces the ready-to-use block an agent reads in ONE call. Design laws enforced here:
 *  - Silent by default: a healthy doc renders with body only; no warning decorations.
 *  - One verdict, folded into the meta line: exactly one status renders.
 *  - Two-class reader: T0/T1 = "mechanical", T2+ = "claimed".
 *  - Partial return on any non-healthy verdict: keep Invariants/Decisions/Why
 *    (the parts the agent should trust), omit code-derived sections it must re-verify anyway.
 *  - At most ONE hint footer (D7): claimed content, or a non-fresh regenerable map.
 *
 * These are pure functions (no I/O) so the golden tests pin the exact output; the CLI wires in
 * the store, the stale engine, and the journal.
 */
import { altitudeFor, altitudeDirective } from './altitude.mjs'
import { LAYER_DIRS } from './indexgen.mjs'
import { parseSections } from './sections.mjs'
import { VERDICT } from './stale.mjs'

/** Section headings whose content survives a partial (non-healthy) return. */
const KEEP_HEADINGS = /^(invariants|decisions|why)$/i

/** Structural path segments (the layer dirs) carry no semantic signal for nearest-match. */
const STRUCTURAL_TERMS = new Set(LAYER_DIRS)

/**
 * @param {string} trust e.g. "T1"
 * @returns {'mechanical'|'claimed'} reader class
 */
function trustClass(trust) {
    return trust === 'T0' || trust === 'T1' ? 'mechanical' : 'claimed'
}

/**
 * @param {string[]} files
 * @param {number} [n] cap before "+N more"
 * @returns {string}
 */
function capList(files, n = 3) {
    return files.length <= n ? files.join(', ') : `${files.slice(0, n).join(', ')} (+${files.length - n} more)`
}

/**
 * The single status phrase folded into the meta line.
 * @param {{verdict: string, affected: string[], notes: string[]}} r
 * @returns {string}
 */
function verdictText(r) {
    switch (r.verdict) {
        case VERDICT.DISPUTED:
            return '⛔ DISPUTED — treat as unconfirmed until a human re-checks'
        case VERDICT.BROKEN:
            return `⛔ BROKEN — source pattern(s) match nothing: ${capList(r.affected)}; re-bind sources`
        case VERDICT.STALE:
            return r.affected.length
                ? `⚠ STALE — sources changed since derivation: ${capList(r.affected)}`
                : `⚠ STALE — ${r.notes[0] ?? 'cannot verify freshness'}`
        case VERDICT.ADVISORY:
            return `ℹ branch advisory — your branch/working tree modifies: ${capList(r.affected)}; verify against the working tree`
        default:
            return 'healthy'
    }
}

/**
 * The optional single hint footer.
 * @param {string} id
 * @param {string} trust
 * @param {string} verdict
 * @returns {string|null}
 */
function hintFor(id, trust, verdict) {
    if (trustClass(trust) === 'claimed')
        return 'hint: T2+ content is claimed, not mechanical — verify against code before relying on it'
    if (id.startsWith('map/') && verdict !== VERDICT.HEALTHY)
        return 'hint: regenerable map — run "kaut map" to refresh'
    return null
}

/**
 * Render the lookup block for a found document.
 * @param {{id: string, fields: Record<string, string|string[]>, body: string}} doc
 * @param {{verdict: string, affected: string[], notes: string[]}} result verdict from stale.mjs
 * @returns {string} the ready-to-use block (trailing newline included)
 */
export function renderLookup(doc, result) {
    const trust = String(doc.fields.trust)
    const meta = `trust: ${trust} (${trustClass(trust)}) · derived: ${String(doc.fields.derived_from_commit).slice(0, 12)} · ${verdictText(result)}`
    // altitude (A3): a parallel scope line, orthogonal to the freshness verdict (one-verdict law
    // intact). Rendered ONLY for a `landscape` doc — its §4.2 confirm directive; component/endpoint
    // stay silent in text (the full band rides in `lookup --json`). Back-derived, never sees the query.
    const directive = altitudeDirective(altitudeFor({ id: doc.id, sources: doc.fields.sources }))
    const out = [`# kaut: ${doc.id}`, meta, ...(directive ? [directive] : []), '']

    if (result.verdict === VERDICT.HEALTHY) {
        const body = String(doc.body).trim()
        if (body) out.push(body)
    } else {
        const { sections } = parseSections(doc.body)
        const kept = sections.filter((s) => KEEP_HEADINGS.test(s.heading))
        for (const s of kept) {
            out.push(`## ${s.heading}`)
            if (s.text) out.push('', s.text)
            out.push('')
        }
        if (result.affected.length) out.push(`affected files: ${result.affected.join(', ')}`)
        const omitted = sections.length - kept.length
        if (omitted > 0) out.push(`(${omitted} section${omitted === 1 ? '' : 's'} omitted — re-derive from code)`)
    }

    const hint = hintFor(doc.id, trust, result.verdict)
    if (hint) out.push('', hint)
    return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n'
}

/**
 * Render the withheld block for a doc whose file differs from the last KAUT commit
 * (out-of-pipeline edit — engine v0.2.1). NOTHING from the file is trusted, not even its
 * frontmatter, so the render carries no trust/derived meta and no body: serving any part of
 * an unprovenanced edit is exactly the injection channel this verdict exists to close.
 * @param {string} id doc id
 * @param {boolean} isMap map docs are regenerable — heal via `kaut map`, not via git
 * @returns {string}
 */
export function renderTampered(id, isMap) {
    const heal = isMap
        ? 'heal: regenerate with "kaut map"'
        : 'heal: discard with "git checkout -- <file>" in the store, or accept it into the pipeline with "kaut index" (records provenance)'
    return [
        `# kaut: ${id}`,
        '⛔ TAMPERED — file changed outside the KAUT pipeline (uncommitted in the store); content withheld',
        '',
        `inspect: "git diff" / "git status" in the store · ${heal}`,
    ].join('\n') + '\n'
}

/**
 * Rank known docs by relevance to a miss query. Case-insensitive: a whole
 * substring hit on `id title` scores highest, then per-term hits; ties break by id. This is the
 * Phase 1 floor of the §13.4 semantic-gap mitigation ("grep all docs before declaring a miss").
 * @param {string} query the unknown topic id
 * @param {Array<{id: string, title: string}>} docs
 * @param {number} [limit]
 * @returns {string[]} nearest doc ids
 */
export function nearestDocs(query, docs, limit = 5) {
    const q = query.toLowerCase()
    const terms = q.split(/[/\s_-]+/).filter((t) => t && !STRUCTURAL_TERMS.has(t))
    const scored = []
    for (const d of docs) {
        const hay = `${d.id} ${d.title}`.toLowerCase()
        let score = hay.includes(q) ? 10 : 0
        for (const t of terms) if (hay.includes(t)) score += 1
        if (score > 0) scored.push({ id: d.id, score })
    }
    scored.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1))
    return scored.slice(0, limit).map((s) => s.id)
}

/**
 * Render a miss (exit 0 — a miss is a valid answer, not an error).
 * @param {string} id the unknown topic id
 * @param {string[]} nearest nearest doc ids (may be empty)
 * @returns {string}
 */
export function renderMiss(id, nearest) {
    const out = [`miss: no doc "${id}"`]
    if (nearest.length) {
        out.push('', 'nearest topics:')
        for (const n of nearest) out.push(`  - ${n}`)
        out.push('', 'open one with: kaut lookup <id>')
    } else {
        out.push('', 'run "kaut lookup" with no argument for the full catalog')
    }
    return out.join('\n') + '\n'
}
