/**
 * INDEX generator (SCHEMA §4).
 *
 * Scans the layer directories, validates every doc against the Phase 0 contract, and
 * renders the single INDEX.md: strict pipe-table + `Gaps` + `Invalid` sections. The INDEX
 * stores NO freshness statuses — verdicts are computed at read time.
 * Invalid docs are listed with reasons, never silently dropped.
 */
import { existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { parseFrontmatter } from './frontmatter.mjs'
import { FILE_TYPES, parseSources } from './sources.mjs'

/**
 * Layer directories scanned for fact documents; the directory IS the layer (D6).
 * contracts/runbook/bootstrap added in v0.3.0 (workspace thin slice) — additive: stores
 * without these dirs scan exactly as before.
 */
export const LAYER_DIRS = ['map', 'domains', 'decisions', 'flows', 'contracts', 'runbook', 'bootstrap']
export const TRUST_LEVELS = ['T0', 'T1', 'T2', 'T3', 'T4']
export const KNOWN_SCHEMA_VERSIONS = ['1']

const REQUIRED_FIELDS = [
    'id',
    'title',
    'sources',
    'derived_from_commit',
    'harvested',
    'engine',
    'trust',
    'checks',
    'schema_version',
]

/**
 * The OKF `type` of a doc is its layer — the first segment of its id (== its directory).
 * OKF (Open Knowledge Format, v0.2) requires a `type`; KAUT derives it from the path, so it need
 * not be stored (store-discipline litmus: derivable cheaply → don't store) and a doc that omits an
 * explicit `type:` is read AS this value. Engine-generated docs stamp it for in-place conformance.
 * @param {string} id store-relative id (no .md)
 * @returns {string} the layer / OKF type
 */
export function typeForId(id) {
    return String(id).split('/')[0]
}

/**
 * Recursively list fact documents under the layer dirs.
 * @param {string} root store root
 * @returns {string[]} sorted store-relative paths (e.g. "domains/routing.md")
 */
export function scanStore(root) {
    const out = []
    const walk = (dir) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, entry.name)
            if (entry.isDirectory()) walk(p)
            else if (entry.name.endsWith('.md')) out.push(path.relative(root, p))
        }
    }
    for (const layer of LAYER_DIRS) {
        const abs = path.join(root, layer)
        if (existsSync(abs)) walk(abs)
    }
    return out.sort()
}

/**
 * Validate one document against the contract (SCHEMA §2).
 * @param {string} relPath store-relative path
 * @param {string} raw file content
 * @returns {{ok: true, fields: Record<string, string|string[]>}|{ok: false, errors: string[]}}
 */
export function validateDoc(relPath, raw) {
    let parsed
    try {
        parsed = parseFrontmatter(raw)
    } catch (e) {
        return { ok: false, errors: [e.message] }
    }
    const f = parsed.fields
    const errors = []

    for (const k of REQUIRED_FIELDS) if (!(k in f)) errors.push(`missing required field "${k}"`)

    const expectedId = relPath.replace(/\.md$/, '')
    if (typeof f.id === 'string' && f.id !== expectedId)
        errors.push(`id "${f.id}" does not match path (expected "${expectedId}")`)

    // OKF `type` (optional, additive): if present it must equal the doc's layer — a doc in domains/
    // claiming type: decisions is an error. Absent ⇒ back-derived via typeForId (no rewrite needed).
    if ('type' in f && String(f.type) !== typeForId(expectedId))
        errors.push(`type "${f.type}" does not match layer (expected "${typeForId(expectedId)}")`)

    if ('sources' in f) {
        if (!Array.isArray(f.sources) || f.sources.length === 0)
            errors.push('sources must be a non-empty list')
        else errors.push(...parseSources(f.sources).errors)
    }
    // The anchor flows into git argv (rev-parse/merge-base/diff) — constrain its shape here
    // so a non-hash value never reaches git looking like an option or a refspec.
    if ('derived_from_commit' in f && !/^[0-9a-fA-F]{7,40}$/.test(String(f.derived_from_commit)))
        errors.push(`derived_from_commit "${f.derived_from_commit}" is not a commit hash (7–40 hex chars)`)
    if (typeof f.trust === 'string' && !TRUST_LEVELS.includes(f.trust))
        errors.push(`unknown trust "${f.trust}" (expected ${TRUST_LEVELS.join('|')})`)
    if ('schema_version' in f && !KNOWN_SCHEMA_VERSIONS.includes(String(f.schema_version)))
        errors.push(`unknown schema_version "${f.schema_version}"`)
    if ('checks' in f && !Array.isArray(f.checks)) errors.push('checks must be a list')
    if ('tickets' in f && !Array.isArray(f.tickets)) errors.push('tickets must be a list')

    return errors.length ? { ok: false, errors } : { ok: true, fields: f }
}

/**
 * Escape `|` so titles cannot break the strict pipe-table.
 * @param {string} s
 * @returns {string}
 */
function esc(s) {
    return String(s).replaceAll('|', '\\|')
}

/**
 * Render INDEX.md content.
 * @param {string} projectId
 * @param {Array<{id: string, title: string, trust: string, commit12: string, fileSources: number}>} docs
 * @param {Array<{path: string, errors: string[]}>} invalid
 * @returns {string}
 */
export function renderIndex(projectId, docs, invalid) {
    const lines = [
        '<!-- GENERATED by kaut index — do not edit. -->',
        `# KAUT INDEX — ${projectId}`,
        '',
        '| id | title | trust | derived_from_commit | sources(files) |',
        '|---|---|---|---|---|',
    ]
    for (const d of docs)
        lines.push(
            `| ${esc(d.id)} | ${esc(d.title)} | ${d.trust} | ${d.commit12} | ${d.fileSources} |`,
        )
    lines.push('', '## Gaps', '', '(none)', '', '## Invalid', '')
    if (invalid.length === 0) lines.push('(none)')
    else for (const inv of invalid) lines.push(`- \`${inv.path}\` — ${inv.errors.join('; ')}`)
    lines.push('')
    return lines.join('\n')
}

/**
 * Scan + validate + render. Pure — performs no writes.
 * @param {string} root store root
 * @param {string} projectId
 * @returns {{content: string, docs: Array<object>, invalid: Array<{path: string, errors: string[]}>}}
 */
export function generateIndex(root, projectId) {
    const docs = []
    const invalid = []
    for (const rel of scanStore(root)) {
        const raw = readFileSync(path.join(root, rel), 'utf8')
        const v = validateDoc(rel, raw)
        if (v.ok) {
            docs.push({
                id: String(v.fields.id),
                title: String(v.fields.title),
                trust: String(v.fields.trust),
                commit12: String(v.fields.derived_from_commit).slice(0, 12),
                fileSources: parseSources(/** @type {string[]} */ (v.fields.sources)).sources.filter(
                    (s) => FILE_TYPES.has(s.type),
                ).length,
            })
        } else {
            invalid.push({ path: rel, errors: v.errors })
        }
    }
    docs.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    return { content: renderIndex(projectId, docs, invalid), docs, invalid }
}

/**
 * Atomic INDEX write: tmp file in the same directory, then rename.
 * @param {string} root store root
 * @param {string} content rendered INDEX.md
 */
export function writeIndex(root, content) {
    const tmp = path.join(root, 'INDEX.md.tmp')
    writeFileSync(tmp, content)
    renameSync(tmp, path.join(root, 'INDEX.md'))
}
