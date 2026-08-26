/**
 * Section parser for fact-document bodies (SCHEMA §2.2).
 *
 * A section is a level-2 heading (`## Title`) optionally followed by binding comments:
 *   <!-- sources: file:a, file-glob:b -->   per-section typed sources (comma-separated)
 *   <!-- trust: T1 ... -->                  per-section trust (free text after the level)
 * A section without its own `sources` binding inherits the doc-level sources at evaluation
 * time (the caller does the inheritance — this module only reports what is written).
 *
 * The parser is deliberately tolerant: unknown comments and free text are kept verbatim in
 * the section's lines. Deeper headings (`###`) are section content, not new sections.
 */

const HEADING_RE = /^##\s+(.+)$/ // level-2 only: "### x" has no space after "##"
const SOURCES_RE = /^<!--\s*sources:\s*(.*?)\s*-->\s*$/
const TRUST_RE = /^<!--\s*trust:\s*(.*?)\s*-->\s*$/

/**
 * @typedef {Object} Section
 * @property {string} heading section title (text after `## `)
 * @property {string[]} sources typed source strings from the `<!-- sources -->` binding ([] if none)
 * @property {string|null} trust raw trust text from the `<!-- trust -->` binding (null if none)
 * @property {string} text the section body (heading + binding comments excluded), trimmed of
 *   leading/trailing blank lines
 */

/**
 * Split a doc body into sections. Content before the first `## ` heading is returned as the
 * `preamble` string (usually empty in KAUT docs).
 * @param {string} body the document body (everything after the frontmatter fence)
 * @returns {{preamble: string, sections: Section[]}}
 */
export function parseSections(body) {
    const lines = String(body).split('\n')
    /** @type {Section[]} */
    const sections = []
    const preamble = []
    /** @type {{heading: string, sources: string[], trust: string|null, body: string[]}|null} */
    let cur = null

    for (const line of lines) {
        const h = line.match(HEADING_RE)
        if (h) {
            if (cur) sections.push(finishSection(cur))
            cur = { heading: h[1].trim(), sources: [], trust: null, body: [] }
            continue
        }
        if (cur) {
            const s = line.match(SOURCES_RE)
            if (s && cur.body.length === 0) {
                // Binding comments are only recognised before any body text, matching how docs
                // are written; a later "<!-- sources -->" is treated as content (kept verbatim).
                cur.sources = splitSources(s[1])
                continue
            }
            const t = line.match(TRUST_RE)
            if (t && cur.body.length === 0) {
                cur.trust = t[1].trim() || null
                continue
            }
            cur.body.push(line)
        } else {
            preamble.push(line)
        }
    }
    if (cur) sections.push(finishSection(cur))
    return { preamble: trimBlank(preamble).join('\n'), sections }
}

/**
 * @param {{heading: string, sources: string[], trust: string|null, body: string[]}} c
 * @returns {Section}
 */
function finishSection(c) {
    return { heading: c.heading, sources: c.sources, trust: c.trust, text: trimBlank(c.body).join('\n') }
}

/**
 * Split a `<!-- sources: a, b -->` payload into trimmed, non-empty source strings.
 * @param {string} raw
 * @returns {string[]}
 */
function splitSources(raw) {
    return raw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
}

/**
 * Drop leading and trailing blank lines (interior blanks are preserved).
 * @param {string[]} arr
 * @returns {string[]}
 */
function trimBlank(arr) {
    let start = 0
    let end = arr.length
    while (start < end && arr[start].trim() === '') start++
    while (end > start && arr[end - 1].trim() === '') end--
    return arr.slice(start, end)
}
