/**
 * Typed-sources grammar (SCHEMA §2.1).
 *
 *   source := "file:" path | "file-glob:" glob | "ticket:" key | "user:" iso-date
 *           | "repo:" name ":file:" path          ; engine v0.3.0, workspace thin slice
 *
 * Only file-typed sources participate in git-diff staleness and the `broken` rule;
 * ticket:/user: are provenance-only. `repo:` sources point into ANOTHER workspace member
 * repo (resolved via the workspace registry) and are EXISTENCE-ONLY checked at that repo's
 * HEAD — full multi-anchor staleness is explicitly post-pilot. Phase 0 validates syntax
 * only — existence of cited files is the micro-verifier's job (Phase 2); `doctor` merely
 * WARNs on missing files.
 */

/** Source types that participate in freshness checking. */
export const FILE_TYPES = new Set(['file', 'file-glob'])

const TYPE_RE = /^(file|file-glob|ticket|user|repo):(.+)$/s
const REPO_VALUE_RE = /^([A-Za-z0-9_.-]+):file:(.+)$/s

/** Grammar violation in one source string. */
export class SourceError extends Error {
    /** @param {string} message */
    constructor(message) {
        super(message)
        this.code = 'KAUT_SOURCE'
    }
}

/**
 * Parse one typed source string.
 * For file types, an OpenAPI-style `#fragment` is stripped into `filePath` for diffing
 * while the raw value keeps the fragment for human reference.
 * @param {string} raw e.g. "file:src/router/routes.ts"
 * @returns {{type: string, value: string, raw: string, filePath?: string}}
 * @throws {SourceError}
 */
export function parseSource(raw) {
    const m = String(raw).match(TYPE_RE)
    if (!m) {
        throw new SourceError(
            `invalid source "${raw}" — expected file:|file-glob:|ticket:|user: prefix with a non-empty value`,
        )
    }
    const [, type, rawValue] = m
    const value = rawValue.trim()
    if (!value) throw new SourceError(`empty value in source "${raw}"`)
    const out = { type, value, raw: String(raw) }
    if (FILE_TYPES.has(type)) out.filePath = value.split('#')[0]
    if (type === 'repo') {
        const rm = value.match(REPO_VALUE_RE)
        if (!rm)
            throw new SourceError(
                `invalid repo source "${raw}" — expected repo:<name>:file:<path>`,
            )
        out.repoName = rm[1]
        out.repoFile = rm[2].trim().split('#')[0]
        if (!out.repoFile) throw new SourceError(`empty path in repo source "${raw}"`)
    }
    return out
}

/**
 * Parse a list of source strings, collecting errors instead of throwing — INDEX reports
 * invalid docs visibly rather than dropping them.
 * @param {string[]} list
 * @returns {{sources: Array<ReturnType<typeof parseSource>>, errors: string[]}}
 */
export function parseSources(list) {
    const sources = []
    const errors = []
    for (const raw of list) {
        try {
            sources.push(parseSource(raw))
        } catch (e) {
            errors.push(e.message)
        }
    }
    return { sources, errors }
}
