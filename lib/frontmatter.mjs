/**
 * Restricted-YAML frontmatter parser/serializer (SCHEMA §3).
 *
 * Supported grammar (normative copy lives in SCHEMA.md):
 *   key: scalar
 *   key:                ← opens a block list
 *       - item
 *   key: []             ← inline empty list
 *   key: [a, b]         ← inline list (no quoting, no nesting)
 *   # full-line comment; a trailing " # comment" on any line is stripped
 *
 * Anything outside this subset is a parse error with a 1-based line number — the parser
 * NEVER guesses. Unknown keys are preserved (tolerant reader).
 */

/** Parse error carrying the offending line number. */
export class FrontmatterError extends Error {
    /**
     * @param {string} message
     * @param {number} line 1-based line number in the source document
     */
    constructor(message, line) {
        super(`${message} (line ${line})`)
        this.code = 'KAUT_FRONTMATTER'
        this.line = line
    }
}

const KEY_RE = /^([A-Za-z_][A-Za-z0-9_-]*):(.*)$/
const LIST_ITEM_RE = /^\s*-\s+(.*)$/

/** Canonical key order for serialization — stable order keeps store diffs minimal (§3.1). */
const CANONICAL_ORDER = [
    'id',
    'type', // OKF type (== layer); optional, stamped on engine-generated docs. See indexgen.typeForId.
    'title',
    'sources',
    'derived_from_commit',
    'harvested',
    'engine',
    'tickets',
    'trust',
    'checks',
    'schema_version',
]

/**
 * Strip a trailing ` # comment`. Values in the contract never contain " #", so this is
 * unambiguous within the restricted subset.
 * @param {string} s
 * @returns {string}
 */
function stripComment(s) {
    const i = s.indexOf(' #')
    return i === -1 ? s : s.slice(0, i)
}

/**
 * Parse a document with restricted-YAML frontmatter.
 * @param {string} raw whole file content
 * @returns {{fields: Record<string, string|string[]>, order: string[], body: string}}
 *   fields — scalar strings or string arrays; order — keys in source order; body — text after
 *   the closing fence, verbatim.
 * @throws {FrontmatterError} on any construct outside the subset
 */
export function parseFrontmatter(raw) {
    const lines = String(raw).split('\n')
    if (lines[0] !== '---') throw new FrontmatterError('document must start with "---"', 1)
    let end = -1
    for (let i = 1; i < lines.length; i++) {
        if (lines[i] === '---') {
            end = i
            break
        }
    }
    if (end === -1) throw new FrontmatterError('unterminated frontmatter (no closing "---")', lines.length)

    /** @type {Record<string, string|string[]>} */
    const fields = {}
    /** @type {string[]} */
    const order = []
    let openList = null

    for (let i = 1; i < end; i++) {
        const line = stripComment(lines[i]).trimEnd()
        if (!line.trim() || line.trim().startsWith('#')) continue

        const listItem = line.match(LIST_ITEM_RE)
        if (listItem) {
            if (!openList) {
                throw new FrontmatterError('list item without an open list key', i + 1)
            }
            // NOTE: no leading "(" on this line — after a same-line `throw` it would be
            // swallowed by ASI into the throw expression and silently skipped.
            const items = /** @type {string[]} */ (fields[openList])
            items.push(listItem[1].trim())
            continue
        }

        const kv = line.match(KEY_RE)
        if (!kv) throw new FrontmatterError(`unrecognized frontmatter line: "${lines[i].trim()}"`, i + 1)
        const [, key, rest] = kv
        if (key in fields) throw new FrontmatterError(`duplicate key "${key}"`, i + 1)
        if (rest !== '' && !rest.startsWith(' '))
            throw new FrontmatterError(`missing space after ":" in "${key}:"`, i + 1)

        const value = rest.trim()
        order.push(key)
        if (value === '') {
            // Bare "key:" opens a block list; empty scalars are not part of the subset.
            fields[key] = []
            openList = key
            continue
        }
        openList = null
        if (value.startsWith('[')) {
            if (!value.endsWith(']'))
                throw new FrontmatterError(`unterminated inline list for "${key}"`, i + 1)
            const inner = value.slice(1, -1).trim()
            fields[key] =
                inner === ''
                    ? []
                    : inner
                          .split(',')
                          .map((s) => s.trim())
                          .filter(Boolean)
        } else {
            fields[key] = value
        }
    }

    return { fields, order, body: lines.slice(end + 1).join('\n') }
}

/**
 * Serialize fields + body back into a document. Canonical keys first (stable diffs),
 * then unknown keys in their original order. Non-empty lists render as 4-space block items;
 * empty lists as `[]`.
 * @param {Record<string, string|string[]|number>} fields
 * @param {string} body
 * @param {string[]} [order] original key order (for unknown-key placement)
 * @returns {string}
 */
export function serializeFrontmatter(fields, body, order = []) {
    const keys = [
        ...CANONICAL_ORDER.filter((k) => k in fields),
        ...order.filter((k) => !CANONICAL_ORDER.includes(k) && k in fields),
    ]
    for (const k of Object.keys(fields)) if (!keys.includes(k)) keys.push(k)

    const out = ['---']
    for (const k of keys) {
        const v = fields[k]
        if (Array.isArray(v)) {
            if (v.length === 0) out.push(`${k}: []`)
            else {
                out.push(`${k}:`)
                for (const item of v) out.push(`    - ${item}`)
            }
        } else {
            out.push(`${k}: ${v}`)
        }
    }
    out.push('---')
    out.push(body)
    return out.join('\n')
}
