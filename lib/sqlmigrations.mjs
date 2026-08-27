/**
 * L0 SQL-migrations map adapter.
 *
 * Filesystem scan for versioned migration files. Primary population: the Flyway naming
 * convention `V<version>__<name>.sql` anywhere under the repo (version = digits separated
 * by `.` or `_`). Fallback population (when no Flyway-named file exists): any `*.sql` under
 * a directory whose name starts with `migration` — those entries carry no parseable
 * version. The map records the total count, the highest-version entries, and which
 * top-level directories hold migrations.
 */
import { readdirSync } from 'node:fs'
import path from 'node:path'
import { serializeFrontmatter } from './frontmatter.mjs'

const SKIP_DIRS = new Set(['node_modules', '.git', 'build', 'target', 'out', '.gradle'])
const FLYWAY_RE = /^V(\d+(?:[._]\d+)*)__(.+)\.sql$/
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
 * Recursively list `.sql` files (sorted, skip list applied).
 * @param {string} repo repo toplevel
 * @returns {string[]} repo-relative `/`-separated paths
 */
function sqlFiles(repo) {
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
                if (!SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name), rel ? `${rel}/${e.name}` : e.name)
            } else if (e.name.endsWith('.sql')) out.push(rel ? `${rel}/${e.name}` : e.name)
        }
    }
    walk(repo, '')
    return out
}

/**
 * Collect the migration population from a repo. Flyway-named files win; otherwise any
 * `*.sql` under a `migration*` directory is the fallback population.
 * @param {string} repo repo toplevel
 * @returns {{entries: Array<{version: number[]|null, versionText: string, name: string, file: string}>,
 *   population: 'flyway'|'fallback'}}
 */
export function collectMigrations(repo) {
    const all = sqlFiles(repo)
    const flyway = []
    for (const rel of all) {
        const m = path.basename(rel).match(FLYWAY_RE)
        if (m)
            flyway.push({
                version: m[1].split(/[._]/).map(Number),
                versionText: m[1].replaceAll('_', '.'),
                name: m[2],
                file: rel,
            })
    }
    if (flyway.length) return { entries: flyway, population: 'flyway' }
    const fallback = all
        .filter((rel) => rel.split('/').slice(0, -1).some((seg) => seg.toLowerCase().startsWith('migration')))
        .map((rel) => ({ version: null, versionText: '', name: path.basename(rel, '.sql'), file: rel }))
    return { entries: fallback, population: 'fallback' }
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

/**
 * Render the `map/migrations.md` T0 document.
 * @param {ReturnType<typeof collectMigrations>} coll
 * @param {{derived: string, harvested: string, version: string}} meta
 * @returns {string}
 */
export function renderMigrationsDoc(coll, meta) {
    const glob = coll.population === 'flyway' ? '**/V*__*.sql' : '**/migration*/**/*.sql'
    const fields = {
        id: 'map/migrations',
        type: 'map', // OKF type (== layer); stamped for in-place conformance
        title: 'Migration map — SQL migrations',
        sources: [`file-glob:${glob}`],
        derived_from_commit: meta.derived,
        harvested: meta.harvested,
        engine: `sql-migrations@${meta.version}`,
        tickets: [],
        trust: 'T0',
        checks: [],
        schema_version: '1',
    }
    const sorted = [...coll.entries].sort((a, b) => {
        if (a.version && b.version) return cmpVersion(b.version, a.version) || a.file.localeCompare(b.file)
        if (a.version) return -1
        if (b.version) return 1
        return b.file.localeCompare(a.file) // unversioned fallback: newest-looking path first
    })
    const top = sorted.slice(0, TOP_ENTRIES)
    const dirs = [...new Set(coll.entries.map((e) => (e.file.includes('/') ? e.file.split('/')[0] : '(toplevel)')))].sort()
    const rows = top.map((e) => `| ${esc(e.versionText || '—')} | ${esc(e.name)} | ${esc(e.file)} |`)
    const body = [
        '',
        '## Migrations',
        `<!-- sources: file-glob:${glob} -->`,
        '<!-- trust: T0 -->',
        '',
        `${coll.entries.length} migrations total (${coll.population === 'flyway' ? 'Flyway V*__*.sql naming' : 'fallback: *.sql under migration* directories, no parseable versions'}).`,
        `Top-level directories holding migrations: ${dirs.map((d) => `\`${d}\``).join(', ')}.`,
        '',
        `Highest-version entries (up to ${TOP_ENTRIES}):`,
        '',
        '| version | name | file |',
        '|---|---|---|',
        ...rows,
        '',
    ].join('\n')
    return serializeFrontmatter(fields, body) + '\n'
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
    if (coll.entries.length === 0) throw new SqlMigrationsError('no SQL migration files found (V*__*.sql or migration*/ *.sql)')
    return { content: renderMigrationsDoc(coll, meta), migrationCount: coll.entries.length }
}
