/**
 * L0 generic HTTP route-map adapter.
 *
 * One lexical, line-based grep covering the common non-JVM backend families:
 *   JS/TS (`**​/*.{js,ts,mjs}`) — Express/Fastify-style `<obj>.get|post|put|delete|patch|use('/path'`
 *     calls and Nest-style `@Get('/path')` decorators;
 *   Python (`**​/*.py`) — decorator idioms `@<obj>.get("/path")` (FastAPI, Sanic, Django Ninja,
 *     aiohttp RouteTableDef, Bottle), `@<obj>.route("/path", methods=[...])` (Flask, Quart,
 *     Sanic, Flask-RESTX namespaces), bare `@get("/path")` / `@route("/path")` (Litestar,
 *     Bottle); aiohttp `add_get("/path")` / `web.get("/path")` / `add_route("GET", "/path")`;
 *     Falcon/Pyramid `add_route(…"/path"…)`; Starlette `Route("/path", …)` / `Mount("/path")`;
 *     Tornado `(r"/path", Handler)` tuples; Django `urls.py` only — `path()` / `re_path()` /
 *     `url()` (with `include()` marked INCLUDE) and DRF `router.register()` (VIEWSET).
 * This is a lexical scan, NOT framework introspection (the doc body says so): dynamically
 * registered or multi-line routes are missed, and string paths must sit on the call's line.
 */
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { serializeFrontmatter } from './frontmatter.mjs'

const SKIP_DIRS = new Set([
    'node_modules', '.git', 'build', 'target', 'out', '.gradle',
    'venv', '.venv', '__pycache__', 'dist',
])
const JS_RE = /\.(js|ts|mjs)$/
const PY_RE = /\.py$/

/** JS: app.get('/x' — the literal must start with '/' to avoid map.get('key') noise. */
const JS_CALL = /\b[A-Za-z_$][\w$]*\.(get|post|put|delete|patch|use)\s*\(\s*(['"`])(\/[^'"`]*)\2/
/** Nest decorator: @Get('/x'), @Post(), bare path optional. */
const NEST_DECO = /@(Get|Post|Put|Delete|Patch)\s*\(\s*(?:(['"`])([^'"`]*)\2)?\s*\)/
/** Python: @app.get("/x") (FastAPI, Sanic, Django Ninja, aiohttp RouteTableDef, Bottle app). */
const PY_DECO = /@[A-Za-z_][\w.]*\.(get|post|put|delete|patch|head|options)\s*\(\s*(['"])([^'"]*)\2/
/** Flask/Quart/Sanic/Bottle: @app.route("/x", methods=["GET", "POST"]) or method="POST". */
const PY_ROUTE = /@[A-Za-z_][\w.]*\.route\s*\(\s*(['"])([^'"]*)\1\s*(?:,.*methods?\s*=\s*(\[[^\]]*\]|['"]\w+['"]))?/
/** Bare decorators: @get("/x") (Litestar), @route("/x", method="POST") (Bottle). */
const PY_BARE = /^\s*@(get|post|put|delete|patch|route)\s*\(\s*(['"])([^'"]*)\2\s*(?:,.*methods?\s*=\s*(\[[^\]]*\]|['"]\w+['"]))?/
/** aiohttp: app.router.add_get("/x", h) · web.get("/x", h) · web.view("/x", V). */
const PY_AIO = /\b(?:\.add_|web\.)(get|post|put|delete|patch|head|options|view)\s*\(\s*(['"])(\/[^'"]*)\2/
/** aiohttp: add_route("GET", "/x", h) — method first. */
const PY_ADD_ROUTE_M = /\.add_route\s*\(\s*(['"])(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS|\*)\1\s*,\s*(['"])(\/[^'"]*)\3/i
/** Falcon app.add_route("/x", res) · Pyramid config.add_route("name", "/x"): first /-literal. */
const PY_ADD_ROUTE = /\.add_route\s*\([^)]*?(['"])(\/[^'"]*)\1/
/** Starlette: Route("/x", endpoint, methods=[...]) · Mount("/x", ...). */
const PY_STARLETTE = /\b(Route|Mount)\s*\(\s*(['"])(\/[^'"]*)\2\s*(?:,.*methods\s*=\s*\[([^\]]*)\])?/
/** Tornado: (r"/x", SomeHandler) handler tuples. */
const PY_TORNADO = /^\s*\(\s*r?(['"])(\/[^'"]*)\1\s*,\s*[A-Z]\w*/
/** Django urls.py: path("x/", view) · re_path(r"^x$", view) · url(r"^x$", view). */
const PY_DJANGO = /^\s*(?:path|re_path|url)\s*\(\s*r?(['"])([^'"]*)\1/
/** DRF: router.register(r"x", ViewSet). */
const PY_DRF = /\.register\s*\(\s*r?(['"])([^'"]*)\1/
const URLS_FILE_RE = /(^|\/)\w*urls\.py$/

/** Thrown when the repo yields no route matches (stack absence — the caller may skip). */
export class HttpRoutesError extends Error {
    /** @param {string} message */
    constructor(message) {
        super(message)
        this.code = 'KAUT_HTTPROUTES'
    }
}

/**
 * Recursively list scannable files (sorted, skip list applied).
 * @param {string} repo repo toplevel
 * @returns {string[]} repo-relative `/`-separated paths
 */
function scanFiles(repo) {
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
            } else if (JS_RE.test(e.name) || PY_RE.test(e.name)) out.push(rel ? `${rel}/${e.name}` : e.name)
        }
    }
    walk(repo, '')
    return out
}

/**
 * Scan one file's content for route rows (line-based).
 * @param {string} src file content
 * @param {string} file repo-relative path
 * @returns {Array<{method: string, path: string, at: string}>} at = `file:line`
 */
export function scanHttpFile(src, file) {
    const rows = []
    const isPy = PY_RE.test(file)
    const lines = src.split('\n')
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        const at = `${file}:${i + 1}`
        if (isPy) {
            const methodsOf = (spec) => (spec ? [...spec.matchAll(/['"](\w+)['"]/g)].map((m) => m[1].toUpperCase()) : [])
            const fr = line.match(PY_ROUTE)
            if (fr) {
                const methods = methodsOf(fr[3])
                for (const method of methods.length ? methods : ['GET']) rows.push({ method, path: fr[2], at })
                continue
            }
            const d = line.match(PY_DECO)
            if (d) {
                rows.push({ method: d[1].toUpperCase(), path: d[3], at })
                continue
            }
            const b = line.match(PY_BARE)
            if (b) {
                const methods = b[1] === 'route' ? methodsOf(b[4]) : [b[1].toUpperCase()]
                for (const method of methods.length ? methods : ['GET']) rows.push({ method, path: b[3], at })
                continue
            }
            const am = line.match(PY_ADD_ROUTE_M)
            if (am) {
                rows.push({ method: am[2] === '*' ? 'ANY' : am[2].toUpperCase(), path: am[4], at })
                continue
            }
            const a = line.match(PY_AIO)
            if (a) {
                rows.push({ method: a[1] === 'view' ? 'ANY' : a[1].toUpperCase(), path: a[3], at })
                continue
            }
            const ar = line.match(PY_ADD_ROUTE)
            if (ar) {
                rows.push({ method: 'ANY', path: ar[2], at })
                continue
            }
            const st = line.match(PY_STARLETTE)
            if (st) {
                if (st[1] === 'Mount') rows.push({ method: 'MOUNT', path: st[3], at })
                else {
                    const methods = st[4] ? [...st[4].matchAll(/['"](\w+)['"]/g)].map((m) => m[1].toUpperCase()) : []
                    for (const method of methods.length ? methods : ['GET']) rows.push({ method, path: st[3], at })
                }
                continue
            }
            if (line.match(PY_TORNADO)) {
                rows.push({ method: 'ANY', path: line.match(PY_TORNADO)[2], at })
                continue
            }
            if (URLS_FILE_RE.test(file)) {
                const dj = line.match(PY_DJANGO)
                if (dj) {
                    const p = dj[2].replace(/^\^/, '').replace(/\$$/, '')
                    rows.push({ method: /\binclude\s*\(/.test(line) ? 'INCLUDE' : 'ANY', path: p.startsWith('/') ? p : `/${p}`, at })
                    continue
                }
                const rr = line.match(PY_DRF)
                if (rr) {
                    const p = rr[2].replace(/^\^/, '').replace(/\$$/, '')
                    rows.push({ method: 'VIEWSET', path: p.startsWith('/') ? p : `/${p}`, at })
                }
            }
            continue
        }
        const c = line.match(JS_CALL)
        if (c) {
            rows.push({ method: c[1].toUpperCase(), path: c[3], at })
            continue
        }
        const n = line.match(NEST_DECO)
        if (n) {
            const p = n[3] ?? ''
            rows.push({ method: n[1].toUpperCase(), path: p.startsWith('/') ? p : `/${p}`, at })
        }
    }
    return rows
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
 * @param {Array<{method: string, path: string, at: string}>} rows
 * @param {{derived: string, harvested: string, version: string}} meta
 * @returns {string}
 */
export function renderHttpRoutesDoc(rows, meta) {
    const sources = ['file-glob:**/*.js', 'file-glob:**/*.ts', 'file-glob:**/*.mjs', 'file-glob:**/*.py']
    const fields = {
        id: 'map/routes',
        type: 'map', // OKF type (== layer); stamped for in-place conformance
        title: 'Route map — HTTP endpoints (lexical scan)',
        sources,
        derived_from_commit: meta.derived,
        harvested: meta.harvested,
        engine: `http-routes@${meta.version}`,
        tickets: [],
        trust: 'T0',
        checks: [],
        schema_version: '1',
    }
    const table = rows.map((r) => `| ${esc(r.method)} | ${esc(r.path)} | ${esc(r.at)} |`)
    const body = [
        '',
        '## Routes',
        `<!-- sources: ${sources.join(', ')} -->`,
        '<!-- trust: T0 -->',
        '',
        `${rows.length} routes. This is a LEXICAL scan, not framework introspection: it greps`,
        'route-registration idioms — Express/Fastify calls, Nest decorators; Python: FastAPI /',
        'Sanic / Django Ninja / aiohttp / Bottle decorators, Flask / Quart route decorators,',
        'Litestar bare decorators, aiohttp `add_get` / `web.get` / `add_route`, Falcon / Pyramid',
        '`add_route`, Starlette `Route` / `Mount`, Tornado handler tuples, Django `urls.py`',
        '(`path` / `re_path` / `url`, `include` → INCLUDE, DRF `router.register` → VIEWSET) —',
        'and misses dynamically registered or multi-line routes. Method column values beyond',
        'HTTP verbs: ANY (method not stated), INCLUDE, VIEWSET, MOUNT, USE.',
        '',
        '| method | path | file:line |',
        '|---|---|---|',
        ...table,
        '',
    ].join('\n')
    return serializeFrontmatter(fields, body) + '\n'
}

/**
 * Scan and render the generic HTTP route map from a repo. Throws {@link HttpRoutesError}
 * when nothing matches (stack absence — distinguishable, skippable).
 * @param {string} repo repo toplevel
 * @param {{derived: string, harvested: string, version: string}} meta
 * @param {object} [opts] reserved (no overrides yet — the scan is convention-free)
 * @returns {{content: string, routeCount: number}}
 */
export function buildHttpRoutes(repo, meta, opts = {}) {
    const rows = []
    for (const rel of scanFiles(repo)) rows.push(...scanHttpFile(readFileSync(path.join(repo, rel), 'utf8'), rel))
    if (rows.length === 0) throw new HttpRoutesError('no http route registrations found (lexical scan over js/ts/mjs/py)')
    rows.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method) || a.at.localeCompare(b.at))
    return { content: renderHttpRoutesDoc(rows, meta), routeCount: rows.length }
}
