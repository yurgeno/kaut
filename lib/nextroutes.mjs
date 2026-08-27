/**
 * L0 Next.js route-map adapter (file-based routing).
 *
 * App Router: `app/**` `page.{js,jsx,ts,tsx}` (kind `page`) and `route.{js,ts}` (kind
 * `route`) — the directory path IS the URL path; `[param]` and `[...slug]` segments are
 * kept literally, route-group `(group)` segments are dropped. Pages Router: `pages/**`
 * `*.{js,jsx,ts,tsx}` excluding `_app`/`_document`/`_error`, with `pages/api/**` as kind
 * `api`. Both routers also probe the `src/app` / `src/pages` variants.
 */
import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { serializeFrontmatter } from './frontmatter.mjs'

const APP_DIRS = ['app', 'src/app']
const PAGES_DIRS = ['pages', 'src/pages']
const PAGE_FILE_RE = /^page\.(js|jsx|ts|tsx)$/
const ROUTE_FILE_RE = /^route\.(js|ts)$/
const PAGES_EXT_RE = /\.(js|jsx|ts|tsx)$/
const PAGES_EXCLUDE = new Set(['_app', '_document', '_error'])

/** Thrown when the repo has no app/pages routing dirs or no route files (stack absence). */
export class NextRoutesError extends Error {
    /** @param {string} message */
    constructor(message) {
        super(message)
        this.code = 'KAUT_NEXTROUTES'
    }
}

/**
 * Recursively list files under a directory (sorted).
 * @param {string} abs absolute directory
 * @returns {string[]} dir-relative `/`-separated paths
 */
function listFiles(abs) {
    const out = []
    const walk = (dir, rel) => {
        let entries
        try {
            entries = readdirSync(dir, { withFileTypes: true })
        } catch {
            return
        }
        for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
            if (e.isDirectory()) walk(path.join(dir, e.name), rel ? `${rel}/${e.name}` : e.name)
            else out.push(rel ? `${rel}/${e.name}` : e.name)
        }
    }
    walk(abs, '')
    return out
}

/**
 * Turn an App Router directory path into a URL path (drop `(group)` segments).
 * @param {string} dirRel app-dir-relative directory ('' = root)
 * @returns {string}
 */
function appUrl(dirRel) {
    const segs = dirRel.split('/').filter((s) => s && !/^\(.*\)$/.test(s))
    return '/' + segs.join('/')
}

/**
 * Collect route rows from a repo.
 * @param {string} repo repo toplevel
 * @returns {{rows: Array<{route: string, kind: 'page'|'route'|'api', file: string}>, bases: string[]}}
 *   bases = the routing dirs found (repo-relative)
 */
export function collectNextRoutes(repo) {
    const rows = []
    const bases = []
    const appDir = APP_DIRS.find((d) => existsSync(path.join(repo, d)))
    if (appDir) {
        bases.push(appDir)
        for (const rel of listFiles(path.join(repo, appDir))) {
            const base = path.basename(rel)
            const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : ''
            if (PAGE_FILE_RE.test(base)) rows.push({ route: appUrl(dir), kind: 'page', file: `${appDir}/${rel}` })
            else if (ROUTE_FILE_RE.test(base)) rows.push({ route: appUrl(dir), kind: 'route', file: `${appDir}/${rel}` })
        }
    }
    const pagesDir = PAGES_DIRS.find((d) => existsSync(path.join(repo, d)))
    if (pagesDir) {
        bases.push(pagesDir)
        for (const rel of listFiles(path.join(repo, pagesDir))) {
            if (!PAGES_EXT_RE.test(rel)) continue
            const noExt = rel.replace(PAGES_EXT_RE, '')
            const segs = noExt.split('/')
            if (PAGES_EXCLUDE.has(segs[segs.length - 1])) continue
            const kind = segs[0] === 'api' ? 'api' : 'page'
            if (segs[segs.length - 1] === 'index') segs.pop()
            rows.push({ route: '/' + segs.join('/'), kind, file: `${pagesDir}/${rel}` })
        }
    }
    rows.sort((a, b) => a.route.localeCompare(b.route) || a.kind.localeCompare(b.kind) || a.file.localeCompare(b.file))
    return { rows, bases }
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
 * Render the `map/routes.md` T0 document (same doc id the other route collectors use —
 * a repo has ONE route map, produced by whichever collector its stack selects).
 * @param {ReturnType<typeof collectNextRoutes>} coll
 * @param {{derived: string, harvested: string, version: string}} meta
 * @returns {string}
 */
export function renderNextRoutesDoc(coll, meta) {
    const sources = coll.bases.map((b) => `file-glob:${b}/**`)
    const fields = {
        id: 'map/routes',
        type: 'map', // OKF type (== layer); stamped for in-place conformance
        title: 'Route map — file-based routes (next)',
        sources,
        derived_from_commit: meta.derived,
        harvested: meta.harvested,
        engine: `next-routes@${meta.version}`,
        tickets: [],
        trust: 'T0',
        checks: [],
        schema_version: '1',
    }
    const rows = coll.rows.map((r) => `| ${esc(r.route)} | ${r.kind} | ${esc(r.file)} |`)
    const body = [
        '',
        '## Routes',
        `<!-- sources: ${sources.join(', ')} -->`,
        '<!-- trust: T0 -->',
        '',
        `${coll.rows.length} routes (file-based routing; \`[param]\` / \`[...slug]\` kept literally, route groups dropped).`,
        '',
        '| route | kind | file |',
        '|---|---|---|',
        ...rows,
        '',
    ].join('\n')
    return serializeFrontmatter(fields, body) + '\n'
}

/**
 * Scan and render the Next.js route map from a repo. Throws {@link NextRoutesError} when
 * the repo has no routing dirs or no route files (stack absence — skippable).
 * @param {string} repo repo toplevel
 * @param {{derived: string, harvested: string, version: string}} meta
 * @param {object} [opts] reserved (no overrides yet — routing dirs are conventional)
 * @returns {{content: string, routeCount: number}}
 */
export function buildNextRoutes(repo, meta, opts = {}) {
    const coll = collectNextRoutes(repo)
    if (coll.bases.length === 0) throw new NextRoutesError('no app/ or pages/ routing directory found (nor src/ variants)')
    if (coll.rows.length === 0) throw new NextRoutesError('no page/route files found under the routing directories')
    return { content: renderNextRoutesDoc(coll, meta), routeCount: coll.rows.length }
}
