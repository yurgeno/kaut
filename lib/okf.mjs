/**
 * OKF v0.2 (Open Knowledge Format) bundle surface — check / stamp / export.
 *
 * Three moves against the OKF hard bar ("every non-reserved .md has parseable frontmatter
 * with a non-empty `type`"): `checkBundle` reports the store's in-place conformance,
 * `stampTypes` backfills the missing `type:` lines through the ordinary round-trip (the
 * serialization chokepoint injects the layer), and `exportBundle` projects the store's HEAD
 * into a standalone conformant bundle — full OKF frontmatter (sources as resource mappings,
 * `generated`/`verified` trust blocks from store git history, native fields riding as legal
 * extension keys) plus the reserved `index.md`/`log.md` files. The exporter WRITES nested
 * YAML by string-building; the restricted READ grammar (frontmatter.mjs) is untouched —
 * bundles are for external consumers, the engine never re-reads them.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { parseFrontmatter, serializeFrontmatter } from './frontmatter.mjs'
import { storeGit } from './gitstore.mjs'
import { LAYER_DIRS, scanStore, typeForId, validateDoc } from './indexgen.mjs'

/** Export/conformance error mapped to exit code 1. */
export class OkfError extends Error {
    /** @param {string} message */
    constructor(message) {
        super(message)
        this.code = 'KAUT_OKF'
    }
}

/** OKF version this module targets. */
export const OKF_VERSION = '0.2'

/** Native keys carried into an exported doc as OKF extension keys, in this order. */
const EXTENSION_ORDER = ['id', 'derived_from_commit', 'harvested', 'engine', 'trust', 'checks', 'schema_version', 'tickets', 'disputed']

/** Keys the exporter re-expresses in OKF shape — everything else rides as an extension. */
const TRANSFORMED_KEYS = new Set(['type', 'title', 'sources'])

/**
 * Report the store's OKF-bundle conformance in place. INDEX.md is a KAUT catalog file, not
 * a concept doc — scanStore never lists it (it lives outside the layer dirs).
 * @param {string} root store root
 * @returns {{concepts: number, missingType: string[], invalid: Array<{path: string, errors: string[]}>}}
 *   concepts — all layer .md files; missingType — parseable docs without a `type:` key;
 *   invalid — contract-invalid docs (the two lists are orthogonal facts, both must be empty)
 */
export function checkBundle(root) {
    let concepts = 0
    const missingType = []
    const invalid = []
    for (const rel of scanStore(root)) {
        concepts++
        const raw = readFileSync(path.join(root, rel), 'utf8')
        try {
            const { fields } = parseFrontmatter(raw)
            if (!('type' in fields)) missingType.push(rel.replace(/\.md$/, ''))
        } catch {
            /* unparseable — validateDoc below reports it with the line number */
        }
        const v = validateDoc(rel, raw)
        if (!v.ok) invalid.push({ path: rel, errors: v.errors })
    }
    return { concepts, missingType, invalid }
}

/**
 * Backfill `type:` on every doc that omits it, by round-tripping parse → serialize (the
 * chokepoint injects the layer). Writes only — committing (and the write gate) is the
 * caller's job. Docs that do not parse, or carry no `id`, are skipped: stamping cannot
 * repair them and `checkBundle`/doctor already surface them.
 * @param {string} root store root
 * @param {{dryRun?: boolean}} [opts] dryRun = report the target ids without writing
 * @returns {string[]} ids stamped (or that would be)
 */
export function stampTypes(root, { dryRun = false } = {}) {
    const stamped = []
    for (const rel of scanStore(root)) {
        const abs = path.join(root, rel)
        let parsed
        try {
            parsed = parseFrontmatter(readFileSync(abs, 'utf8'))
        } catch {
            continue
        }
        if ('type' in parsed.fields || typeof parsed.fields.id !== 'string') continue
        stamped.push(rel.replace(/\.md$/, ''))
        if (!dryRun) writeFileSync(abs, serializeFrontmatter(parsed.fields, parsed.body, parsed.order))
    }
    return stamped
}

/**
 * A committed blob's exact bytes. storeGit trims (fine for log/rev output) — body bytes must
 * survive verbatim, so this is the one untrimmed git read.
 * @param {string} root store root
 * @param {string} rel store-relative path
 * @returns {string}
 */
function headBlob(root, rel) {
    return execFileSync('git', ['-c', 'core.quotepath=false', 'show', `HEAD:${rel}`], { cwd: root, encoding: 'utf8' })
}

/**
 * Render a scalar as a YAML value: plain when unambiguous, double-quoted (JSON escaping is
 * valid YAML) otherwise. The exporter quotes rather than guesses — a bundle must parse.
 * @param {string|number} v
 * @returns {string}
 */
function yamlScalar(v) {
    const s = String(v)
    return /^[A-Za-z0-9@._/-]+$/.test(s) ? s : JSON.stringify(s)
}

/**
 * First non-empty, non-heading, non-comment body line, de-markdowned (emphasis, backticks,
 * leading list markers stripped) and cut to 200 chars at a word boundary.
 * @param {string} body
 * @returns {string} '' when the body yields nothing
 */
export function descriptionFor(body) {
    for (const line of String(body).split('\n')) {
        const t = line.trim()
        if (!t || t.startsWith('#') || t.startsWith('<!--')) continue
        const clean = t
            .replace(/^[-*+]\s+/, '')
            .replace(/[*_`]/g, '')
            .trim()
        if (!clean) continue
        if (clean.length <= 200) return clean
        const cut = clean.slice(0, 200)
        const space = cut.lastIndexOf(' ')
        return (space > 0 ? cut.slice(0, space) : cut).trim()
    }
    return ''
}

/**
 * `[owner-approved: id1, id2]` commits touching `rel` whose id list names `id` — the human
 * verification events for the OKF trust family. Newest first (git log order).
 * @param {string} root store root
 * @param {string} rel store-relative path
 * @param {string} id doc id
 * @returns {Array<{author: string, at: string}>}
 */
function approvalsFor(root, rel, id) {
    const out = []
    const log = storeGit(root, ['log', '--format=%cI%x09%s', 'HEAD', '--', rel])
    for (const line of log ? log.split('\n') : []) {
        const [at, subject] = line.split('\t')
        const m = subject?.match(/\[owner-approved: ([^\]]+)\]/)
        if (m && m[1].split(',').map((s) => s.trim()).includes(id))
            out.push({ author: ownerName(), at })
    }
    return out
}

/**
 * Store commits are authored under the ENGINE's git identity (gitstore sets it), never a
 * person's — so the approving PERSON behind an owner-gate landing is the operator's own
 * identity: an `--approve` only ever runs from the owner's environment. Resolved once
 * per process; the commit %an is deliberately ignored.
 * @returns {string}
 */
let ownerNameCache
function ownerName() {
    if (ownerNameCache === undefined) {
        try {
            ownerNameCache = execFileSync('git', ['config', '--global', 'user.name'], { encoding: 'utf8' }).trim() || 'owner'
        } catch {
            ownerNameCache = 'owner'
        }
    }
    return ownerNameCache
}

/**
 * Project one committed doc into OKF v0.2 frontmatter + verbatim body.
 * @param {string} root store root
 * @param {string} rel store-relative path
 * @returns {{id: string, title: string, description: string, content: string}}
 */
function exportDoc(root, rel) {
    let parsed
    try {
        parsed = parseFrontmatter(headBlob(root, rel))
    } catch (e) {
        throw new OkfError(`cannot export ${rel} — frontmatter does not parse: ${e.message}`)
    }
    const { fields, order, body } = parsed
    const id = typeof fields.id === 'string' ? fields.id : rel.replace(/\.md$/, '')
    const title = typeof fields.title === 'string' ? fields.title : id
    const description = descriptionFor(body)

    const lines = ['---', `type: ${yamlScalar(typeForId(id))}`, `title: ${yamlScalar(title)}`]
    if (description) lines.push(`description: ${yamlScalar(description)}`)
    if (Array.isArray(fields.sources) && fields.sources.length) {
        lines.push('sources:')
        // each native typed string IS a valid OKF scope descriptor — carried verbatim
        for (const s of fields.sources) lines.push(`  - resource: ${JSON.stringify(String(s))}`)
    }
    if (typeof fields.engine === 'string') {
        lines.push('generated:')
        lines.push(`  by: ${yamlScalar(fields.engine.replace('@', '/'))}`) // actor convention: <producer>/<version>
        lines.push(`  at: ${yamlScalar(storeGit(root, ['log', '-1', '--format=%cI', 'HEAD', '--', rel]))}`)
    }
    const approvals = approvalsFor(root, rel, id)
    if (approvals.length) {
        // omitted when none: an unapproved doc is honestly unverified/machine-tier
        lines.push('verified:')
        for (const a of approvals) {
            lines.push(`  - by: ${yamlScalar(`human:${a.author}`)}`)
            lines.push(`    at: ${yamlScalar(a.at)}`)
        }
    }
    const extKeys = [
        ...EXTENSION_ORDER.filter((k) => k in fields),
        ...order.filter((k) => k in fields && !EXTENSION_ORDER.includes(k) && !TRANSFORMED_KEYS.has(k)),
    ]
    for (const k of extKeys) {
        const v = fields[k]
        if (Array.isArray(v)) {
            if (v.length === 0) lines.push(`${k}: []`)
            else {
                lines.push(`${k}:`)
                for (const item of v) lines.push(`  - ${yamlScalar(item)}`)
            }
        } else lines.push(`${k}: ${yamlScalar(v)}`)
    }
    lines.push('---')
    return { id, title, description, content: lines.join('\n') + '\n' + body }
}

/**
 * Reserved bundle-root `index.md`: the only place `okf_version` may live; per-layer listing.
 * @param {string} name bundle/store name
 * @param {Array<{id: string, title: string, description: string}>} concepts
 * @returns {string}
 */
function renderBundleIndex(name, concepts) {
    const lines = ['---', `okf_version: "${OKF_VERSION}"`, '---', '', `# ${name} — OKF bundle`]
    const layers = [...new Set(concepts.map((c) => typeForId(c.id)))].sort()
    for (const layer of layers) {
        lines.push('', `## ${layer}`, '')
        for (const c of concepts.filter((x) => typeForId(x.id) === layer))
            lines.push(`* [${c.title}](/${c.id}.md)${c.description ? ` - ${c.description}` : ''}`)
    }
    lines.push('')
    return lines.join('\n')
}

/**
 * Reserved bundle-root `log.md`: store git history per OKF convention — ISO date headings
 * newest-first, bold-word bullets. Capped at the 100 most recent commits.
 * @param {string} root store root
 * @returns {string}
 */
function renderBundleLog(root) {
    const lines = ['# Log']
    const log = storeGit(root, ['log', '-100', '--format=%cI%x09%s', 'HEAD'])
    let day = null
    for (const line of log ? log.split('\n') : []) {
        const [at, subject] = line.split('\t')
        const d = at.slice(0, 10)
        if (d !== day) {
            day = d
            lines.push('', `## ${d}`, '')
        }
        lines.push(`* **Update** ${subject}`)
    }
    lines.push('')
    return lines.join('\n')
}

/**
 * Project the store's HEAD (committed content only — the same trust boundary as tamper
 * containment) into a conformant OKF v0.2 bundle at `outDir`.
 * @param {string} root store root
 * @param {string} outDir bundle target directory
 * @param {{force?: boolean}} [opts] force = allow a non-empty target
 * @returns {{count: number, dir: string}} exported concept count + resolved bundle dir
 * @throws {OkfError} on a target inside the store, a non-empty target without force, or an
 *   unparseable committed doc
 */
export function exportBundle(root, outDir, { force = false } = {}) {
    const dir = path.resolve(outDir)
    const fromStore = path.relative(path.resolve(root), dir)
    if (fromStore === '' || (!fromStore.startsWith('..') && !path.isAbsolute(fromStore)))
        throw new OkfError(`export target must live outside the store: ${dir}`)
    if (existsSync(dir) && readdirSync(dir).length && !force)
        throw new OkfError(`export target is not empty: ${dir} — re-run with --force to write into it`)

    // HEAD's layer docs only — never INDEX.md, journal/obligations telemetry, config, .gitignore,
    // or the .drafts queue (queue ≠ knowledge).
    const head = storeGit(root, ['ls-tree', '-r', '--name-only', 'HEAD'])
    const docs = (head ? head.split('\n') : []).filter(
        (rel) => rel.endsWith('.md') && LAYER_DIRS.includes(typeForId(rel)),
    )
    const concepts = []
    for (const rel of docs) {
        const doc = exportDoc(root, rel)
        const abs = path.join(dir, rel)
        mkdirSync(path.dirname(abs), { recursive: true })
        writeFileSync(abs, doc.content)
        concepts.push(doc)
    }
    mkdirSync(dir, { recursive: true }) // a store with zero docs still yields a valid bundle
    writeFileSync(path.join(dir, 'index.md'), renderBundleIndex(path.basename(path.resolve(root)), concepts))
    writeFileSync(path.join(dir, 'log.md'), renderBundleLog(root))
    return { count: concepts.length, dir }
}
