/**
 * Coverage/scope-confidence signal — `altitude` (SCHEMA §25). A SECOND axis on the
 * lookup verdict surface, orthogonal to freshness: at what ZOOM does this artifact
 * describe the system?
 *   landscape — cross-repo overview (what talks to what)
 *   component — one repo/module's internals
 *   endpoint  — a specific route/handler/field-level wiring
 * Freshness answers "is it current?"; altitude answers "is it at the granularity your
 * question needs?". A HEALTHY-but-coarse doc reads as coverage for a fine question and
 * nothing warned — the gap this signal closes.
 *
 * altitude is BACK-DERIVED (zero distillation burden, like the OKF `type`), NEVER sees the
 * question (a property of the DOC alone, so it composes with topic-addressed lookup and
 * cannot drift into retrieval/RAG), and pairs a `landscape` band with a §4.2 confirm-in-code
 * directive so a coarse artifact cannot be silently over-trusted. Derivation is LAYER-PRIMARY
 * with repo-span as a tie-breaker only WITHIN coarse layers — the naive "≥2 repos ⇒ landscape
 * regardless of layer" over-fires on fine docs whose sources span repos via globs + a
 * cross-check (e.g. an entity-map), so it was rejected in design review.
 */
import { FILE_TYPES, parseSources } from './sources.mjs'

export const BANDS = Object.freeze({ LANDSCAPE: 'landscape', COMPONENT: 'component', ENDPOINT: 'endpoint' })

/** Coarse layers — cross-repo overviews; eligible for `landscape` when their sources span ≥2 repos. */
const COARSE_LAYERS = new Set(['map', 'contracts', 'flows'])
/** Fine layers — component/endpoint detail; never `landscape` regardless of repo span. */
const FINE_LAYERS = new Set(['domains', 'runbook'])
/** Max pinpoint `file:` sources (and no globs) for a fine-layer doc to read as endpoint-precise. */
const ENDPOINT_MAX_FILES = 2

/**
 * Distinct repos a doc's sources touch: each `repo:<name>:…` is that named member; any local
 * `file:`/`file-glob:` source counts as the store's OWN repo (one identity). Mirrors the
 * source grammar in sources.mjs.
 * @param {Array<{type: string, repoName?: string}>} parsed
 * @returns {number}
 */
function distinctRepos(parsed) {
    const repos = new Set()
    let hasLocal = false
    for (const s of parsed) {
        if (s.type === 'repo') repos.add(s.repoName)
        else if (FILE_TYPES.has(s.type)) hasLocal = true
    }
    return repos.size + (hasLocal ? 1 : 0)
}

/**
 * File-source shape for endpoint detection: `pinpoint` counts exact `file:`/`repo:…:file:`
 * paths; a `file-glob:` source means the doc spans a directory/pattern → not endpoint-precise.
 * @param {Array<{type: string}>} parsed
 * @returns {{pinpoint: number, hasGlob: boolean}}
 */
function fileShape(parsed) {
    let pinpoint = 0
    let hasGlob = false
    for (const s of parsed) {
        if (s.type === 'file-glob') hasGlob = true
        else if (s.type === 'file' || s.type === 'repo') pinpoint++
    }
    return { pinpoint, hasGlob }
}

/**
 * Back-derive a doc's altitude band from its layer (== id prefix, mirrors indexgen.typeForId)
 * + its sources. Pure; never sees the question, so it is identical for every caller.
 * @param {{id: string, sources?: string[]|string}} doc store id and raw source strings
 * @returns {{band: string, distinctRepos: number, basis: string, confirmDirective: boolean}}
 */
export function altitudeFor({ id, sources }) {
    const layer = String(id ?? '').split('/')[0]
    const list = Array.isArray(sources) ? sources : sources ? [sources] : []
    const { sources: parsed } = parseSources(list)
    const repos = distinctRepos(parsed)
    let band
    if (COARSE_LAYERS.has(layer)) {
        band = repos >= 2 ? BANDS.LANDSCAPE : BANDS.COMPONENT
    } else if (FINE_LAYERS.has(layer)) {
        const { pinpoint, hasGlob } = fileShape(parsed)
        band = !hasGlob && pinpoint > 0 && pinpoint <= ENDPOINT_MAX_FILES ? BANDS.ENDPOINT : BANDS.COMPONENT
    } else {
        band = BANDS.COMPONENT // decisions, bootstrap, unknown — coarser-than-endpoint, no directive
    }
    return {
        band,
        distinctRepos: repos,
        basis: `type=${layer || '?'}; ${repos} repo${repos === 1 ? '' : 's'}`,
        confirmDirective: band === BANDS.LANDSCAPE,
    }
}

/**
 * The one scope line rendered under the meta line for a `landscape` doc — and ONLY landscape:
 * component/endpoint stay silent in text (the full band is always in `lookup --json`).
 * This is a parallel scope line, NOT a verdict — the one-verdict law (freshness is the single
 * status phrase) is untouched.
 * @param {ReturnType<typeof altitudeFor>} alt
 * @returns {string|null}
 */
export function altitudeDirective(alt) {
    if (!alt.confirmDirective) return null
    return `altitude: ${alt.band} (cross-repo overview · ${alt.distinctRepos} repos) — endpoint-level specifics are below this doc's resolution; confirm them against code (§4.2)`
}
