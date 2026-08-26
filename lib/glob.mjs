/**
 * Zero-dependency glob matcher.
 *
 * Supported wildcards on `/`-separated, repo-relative paths — exactly this subset
 * (anything else is matched literally, never silently widened):
 *   **   any number of path segments, including zero (crosses `/`)
 *   *    any run of characters within one segment (never crosses `/`)
 *   ?    one character within one segment (never crosses `/`)
 *
 * The subset is normative (documented in SCHEMA.md). It covers every glob currently used in
 * `kaut.config.json` and in fact-doc `file-glob:` sources. Node ships no stable built-in
 * glob and a dependency is forbidden, so freshness/`broken` checking compiles globs here.
 */

/** Regex metacharacters to escape when a glob character is a literal. `*` and `?` are handled separately; `/` is not special in JS regex. */
const REGEX_SPECIAL = new Set(['.', '+', '^', '$', '(', ')', '[', ']', '{', '}', '|', '\\'])

/**
 * Compile a glob into an anchored RegExp.
 *
 * `**` semantics depend on the following character: `**​/` consumes zero or more whole leading
 * segments (so `a/**​/b` matches `a/b`, `a/x/b`, `a/x/y/b`); a trailing or bare `**` matches the
 * rest of the path across `/` (so `pkg/utils/**` matches `pkg/utils/c.ts` and `pkg/utils/x/y.ts`).
 * @param {string} glob
 * @returns {RegExp} anchored matcher
 */
export function globToRegExp(glob) {
    let re = '^'
    for (let i = 0; i < glob.length; i++) {
        const c = glob[i]
        if (c === '*') {
            if (glob[i + 1] === '*') {
                i++ // consume the second '*'
                if (glob[i + 1] === '/') {
                    i++ // consume the '/' so it is part of the globstar, not a literal
                    re += '(?:[^/]+/)*' // zero or more whole leading segments
                } else {
                    re += '.*' // trailing/bare globstar: rest of the path, crossing '/'
                }
            } else {
                re += '[^/]*' // single-segment wildcard
            }
        } else if (c === '?') {
            re += '[^/]'
        } else if (REGEX_SPECIAL.has(c)) {
            re += '\\' + c
        } else {
            re += c
        }
    }
    return new RegExp(re + '$')
}

/**
 * Test one path against one glob.
 * @param {string} glob
 * @param {string} filePath repo-relative, `/`-separated
 * @returns {boolean}
 */
export function matchGlob(glob, filePath) {
    return globToRegExp(glob).test(filePath)
}

/**
 * Does any path in `paths` match the glob? Used by the `broken` rule (a file-typed source that
 * matches zero existing paths is broken, never fresh).
 * @param {string} glob
 * @param {Iterable<string>} paths
 * @returns {boolean}
 */
export function anyMatch(glob, paths) {
    const re = globToRegExp(glob)
    for (const p of paths) if (re.test(p)) return true
    return false
}

/**
 * All paths in `paths` that match the glob (compiles the regex once).
 * Used to attach the offending file list to a `stale`/`branch-advisory` verdict.
 * @param {string} glob
 * @param {Iterable<string>} paths
 * @returns {string[]}
 */
export function filterMatch(glob, paths) {
    const re = globToRegExp(glob)
    const out = []
    for (const p of paths) if (re.test(p)) out.push(p)
    return out
}
