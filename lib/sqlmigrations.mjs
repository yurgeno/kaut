/**
 * L0 migrations map adapter (SQL and Python migration families).
 *
 * Filesystem scan for versioned migration files, one population per family:
 *   flyway  — `V<version>__<name>.sql` anywhere under the repo (version = digits separated
 *             by `.` or `_`);
 *   django  — `<app>/migrations/<NNNN>_<name>.py` (version = NNNN, scoped per app);
 *   alembic — `versions/<file>.py` carrying a `revision = "<id>"` assignment; ordered along
 *             the `down_revision` chain (base first) when the chain is intact, else by file;
 *   fallback — any `*.sql` under a directory whose name starts with `migration`, used only
 *             when no Flyway-named file exists (no parseable versions).
 * The map records the total count, the newest entries per family, and which top-level
 * directories hold migrations. No migration tool is invoked.
 */
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { serializeFrontmatter } from './frontmatter.mjs'

const SKIP_DIRS = new Set([
    'node_modules', '.git', 'build', 'target', 'out', '.gradle',
    'venv', '.venv', '__pycache__', 'dist', 'site-packages', '.tox', '.nox',
])
const FLYWAY_RE = /^V(\d+(?:[._]\d+)*)__(.+)\.sql$/
const DJANGO_RE = /^(\d{4})_(.+)\.py$/
const ALEMBIC_REV_RE = /^\s*revision(?:\s*:\s*(?:str|Union\[[^\]]*\]))?\s*=\s*['"]([^'"]+)['"]/m
const ALEMBIC_DOWN_RE = /^\s*down_revision(?:\s*:\s*[^=]+?)?\s*=\s*(?:['"]([^'"]+)['"]|None)/m
const TOP_ENTRIES = 15

/** Thrown when the repo holds no migration files (stack absence — the caller may skip). */
export class SqlMigrationsError extends Error {
    /** @param {string} message */
    constructor(message) {
        super(message)
        this.code = 'KAUT_SQLMIGRATIONS'
    }
}

/**
 * Recursively list `.sql` and `.py` files (sorted, skip list applied).
 * @param {string} repo repo toplevel
 * @returns {string[]} repo-relative `/`-separated paths
 */
function candidateFiles(repo) {
    const out = []
    const walk = (dir, rel) => {
        let entries
        try {
            entries = readdirSync(dir, { withFileTypes: true })
        } catch {
            return
        }
        for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
            if (e.isDirectory()) {
                if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) walk(path.join(dir, e.name), rel ? `${rel}/${e.name}` : e.name)
            } else if (e.name.endsWith('.sql') || e.name.endsWith('.py')) out.push(rel ? `${rel}/${e.name}` : e.name)
        }
    }
    walk(repo, '')
    return out
}

/**
 * Order Alembic revisions along their `down_revision` chain (base first). Falls back to
 * file order when the chain is broken (missing parent, cycle, or merge points).
 * @param {Array<{rev: string, down: string|null, file: string}>} revs
 * @returns {Map<string, number>} rev → 1-based chain position
 */
export function alembicChainOrder(revs) {
    const byRev = new Map(revs.map((r) => [r.rev, r]))
    const pos = new Map()
    const children = new Map()
    for (const r of revs) {
        if (r.down === null) continue
        if (!byRev.has(r.down)) return pos // parent outside the scanned set → no chain
        children.set(r.down, [...(children.get(r.down) ?? []), r.rev])
    }
    const bases = revs.filter((r) => r.down === null)
    if (bases.length !== 1) return pos // multiple bases or none → no single chain
    let n = 0
    const queue = [bases[0].rev]
    while (queue.length) {
        const rev = queue.shift()
        if (pos.has(rev)) return new Map() // cycle
        pos.set(rev, ++n)
        queue.push(...(children.get(rev) ?? []).sort())
    }
    return pos.size === revs.length ? pos : new Map()
}

/**
 * Collect the migration population from a repo, grouped by family. Flyway-named SQL files
 * win over the SQL fallback; the Python families are independent additions.
 * @param {string} repo repo toplevel
 * @returns {{entries: Array<{family: 'flyway'|'django'|'alembic'|'fallback', version: number[]|null,
 *   versionText: string, name: string, file: string, group: string}>,
 *   families: Array<'flyway'|'django'|'alembic'|'fallback'>, population: string}}
 *   population = the families present joined with `+` (`flyway`, `django+alembic`, …)
 */
export function collectMigrations(repo) {
    const all = candidateFiles(repo)
    const entries = []
    const sql = all.filter((f) => f.endsWith('.sql'))
    for (const rel of sql) {
        const m = path.basename(rel).match(FLYWAY_RE)
        if (m)
            entries.push({
                family: 'flyway',
                version: m[1].split(/[._]/).map(Number),
                versionText: m[1].replaceAll('_', '.'),
                name: m[2],
                file: rel,
                group: '',
            })
    }
    if (!entries.some((e) => e.family === 'flyway'))
        for (const rel of sql)
            if (rel.split('/').slice(0, -1).some((seg) => seg.toLowerCase().startsWith('migration')))
                entries.push({ family: 'fallback', version: null, versionText: '', name: path.basename(rel, '.sql'), file: rel, group: '' })

    const alembic = []
    for (const rel of all) {
        if (!rel.endsWith('.py')) continue
        const segs = rel.split('/')
        const parent = segs.length > 1 ? segs[segs.length - 2] : ''
        const base = segs[segs.length - 1]
        const dj = parent === 'migrations' && base.match(DJANGO_RE)
        if (dj) {
            const app = segs.length > 2 ? segs[segs.length - 3] : '(toplevel)'
            entries.push({ family: 'django', version: [Number(dj[1])], versionText: `${app}:${dj[1]}`, name: dj[2], file: rel, group: app })
            continue
        }
        if (parent !== 'versions') continue
        let src
        try {
            src = readFileSync(path.join(repo, rel), 'utf8')
        } catch {
            continue
        }
        const rev = src.match(ALEMBIC_REV_RE)
        if (!rev) continue
        const down = src.match(ALEMBIC_DOWN_RE)
        alembic.push({ rev: rev[1], down: down && down[1] ? down[1] : null, file: rel, name: base.replace(/\.py$/, '').replace(new RegExp(`^${rev[1]}_?`), '') || base })
    }
    if (alembic.length) {
        const order = alembicChainOrder(alembic)
        for (const a of alembic)
            entries.push({
                family: 'alembic',
                version: order.has(a.rev) ? [order.get(a.rev)] : null,
                versionText: a.rev,
                name: a.name,
                file: a.file,
                group: a.file.split('/').slice(0, -1).join('/'),
            })
    }
    const families = ['flyway', 'django', 'alembic', 'fallback'].filter((f) => entries.some((e) => e.family === f))
    return { entries, families, population: families.join('+') }
}

/**
 * Compare two dotted version arrays numerically, part by part.
 * @param {number[]} a
 * @param {number[]} b
 * @returns {number}
 */
function cmpVersion(a, b) {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
        const d = (a[i] ?? 0) - (b[i] ?? 0)
        if (d) return d
    }
    return 0
}

/**
 * Escape `|` so a cell cannot break the pipe table.
 * @param {string} s
 * @returns {string}
 */
function esc(s) {
    return String(s).replaceAll('|', '\\|')
}

const FAMILY_GLOB = {
    flyway: '**/V*__*.sql',
    django: '**/migrations/????_*.py',
    alembic: '**/versions/*.py',
    fallback: '**/migration*/**/*.sql',
}
const FAMILY_LABEL = {
    flyway: 'Flyway V*__*.sql naming',
    django: 'Django `<app>/migrations/NNNN_*.py` (version scoped per app)',
    alembic: 'Alembic `versions/*.py` (ordered along the down_revision chain when intact)',
    fallback: 'fallback: *.sql under migration* directories, no parseable versions',
}

/**
 * Render the `map/migrations.md` T0 document.
 * @param {ReturnType<typeof collectMigrations>} coll
 * @param {{derived: string, harvested: string, version: string}} meta
 * @returns {string}
 */
export function renderMigrationsDoc(coll, meta) {
    const globs = coll.families.map((f) => FAMILY_GLOB[f])
    const sources = globs.map((g) => `file-glob:${g}`)
    const fields = {
        id: 'map/migrations',
        type: 'map', // OKF type (== layer); stamped for in-place conformance
        title: 'Migration map — versioned migrations',
        sources,
        derived_from_commit: meta.derived,
        harvested: meta.harvested,
        engine: `sql-migrations@${meta.version}`,
        tickets: [],
        trust: 'T0',
        checks: [],
        schema_version: '1',
    }
    const dirs = [...new Set(coll.entries.map((e) => (e.file.includes('/') ? e.file.split('/')[0] : '(toplevel)')))].sort()
    const summary = coll.families.map((f) => `${coll.entries.filter((e) => e.family === f).length} ${f} (${FAMILY_LABEL[f]})`)
    const body = [
        '',
        '## Migrations',
        `<!-- sources: ${sources.join(', ')} -->`,
        '<!-- trust: T0 -->',
        '',
        `${coll.entries.length} migrations total: ${summary.join('; ')}.`,
        `Top-level directories holding migrations: ${dirs.map((d) => `\`${d}\``).join(', ')}.`,
        'Filesystem scan only — no migration tool is invoked.',
    ]
    for (const f of coll.families) {
        const sorted = coll.entries
            .filter((e) => e.family === f)
            .sort((a, b) => {
                if (a.group !== b.group) return a.group.localeCompare(b.group)
                if (a.version && b.version) return cmpVersion(b.version, a.version) || a.file.localeCompare(b.file)
                if (a.version) return -1
                if (b.version) return 1
                return b.file.localeCompare(a.file) // unversioned fallback: newest-looking path first
            })
        const top = sorted.slice(0, TOP_ENTRIES)
        body.push(
            '',
            `### ${f}`,
            '',
            `Newest entries (up to ${TOP_ENTRIES}${f === 'django' ? ', per app' : ''}):`,
            '',
            '| version | name | file |',
            '|---|---|---|',
            ...top.map((e) => `| ${esc(e.versionText || '—')} | ${esc(e.name)} | ${esc(e.file)} |`),
        )
    }
    body.push('')
    return serializeFrontmatter(fields, body.join('\n')) + '\n'
}

/**
 * Scan and render the migration map from a repo. Throws {@link SqlMigrationsError} when
 * no migration files exist (stack absence — distinguishable, skippable).
 * @param {string} repo repo toplevel
 * @param {{derived: string, harvested: string, version: string}} meta
 * @param {object} [opts] reserved (no overrides yet — locations are discovered)
 * @returns {{content: string, migrationCount: number}}
 */
export function buildSqlMigrations(repo, meta, opts = {}) {
    const coll = collectMigrations(repo)
    if (coll.entries.length === 0)
        throw new SqlMigrationsError('no migration files found (V*__*.sql, migration*/ *.sql, migrations/NNNN_*.py, versions/*.py with revision)')
    return { content: renderMigrationsDoc(coll, meta), migrationCount: coll.entries.length }
}
