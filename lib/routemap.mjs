/**
 * L0 route-map adapter (SCHEMA §14).
 *
 * Honestly Nx/JS-specific: a line-based parser for this repo's very regular `routes.ts`
 * (one field per line, lazy `@packages/<pkg>/views` imports, `ROUTER_PATH.<Key>` references,
 * `children:` nesting) plus `ROUTER_PATH` literal resolution from `constants.ts`. This is NOT a
 * general AST — L0 deliberately targets Nx/JS first.
 *
 * Safety net (D12): every `path:` line must resolve to a literal. If any does not, the parser
 * throws and the caller writes nothing — the map never silently drops a route it failed to
 * understand. `resolvedCount === total path: lines` is the mechanical self-check.
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { serializeFrontmatter } from './frontmatter.mjs'

const ROUTES_FILE = 'src/router/routes.ts'
const CONSTANTS_FILE = 'packages/core/src/utils/constants.ts'

/** Thrown when the route file cannot be parsed into a complete, resolved table. */
export class RouteMapError extends Error {
    /** @param {string} message */
    constructor(message) {
        super(message)
        this.code = 'KAUT_ROUTEMAP'
    }
}

/**
 * Parse the `ROUTER_PATH` object from constants.ts into `Key → {Path, Page, Title}`.
 * Bounded by brace depth from `const ROUTER_PATH = {` so unrelated constants are ignored.
 * @param {string} src constants.ts content
 * @returns {Map<string, {Path: string, Page: string, Title: string}>}
 */
export function parseRouterPath(src) {
    const lines = src.split('\n')
    const map = new Map()
    let depth = 0
    let started = false
    /** @type {{key: string, e: {Path?: string, Page?: string, Title?: string}}|null} */
    let cur = null

    const braces = (s) => (s.match(/\{/g) || []).length - (s.match(/\}/g) || []).length

    for (const line of lines) {
        if (!started) {
            if (/const\s+ROUTER_PATH\s*=\s*\{/.test(line)) {
                started = true
                depth += braces(line)
            }
            continue
        }
        const keyOpen = line.match(/^\s+([A-Za-z0-9_]+):\s*\{/)
        if (keyOpen && depth === 1) cur = { key: keyOpen[1], e: {} }
        else if (cur) {
            const p = line.match(/^\s*Path:\s*'([^']*)'/)
            const g = line.match(/^\s*Page:\s*'([^']*)'/)
            const t = line.match(/^\s*Title:\s*'([^']*)'/)
            if (p) cur.e.Path = p[1]
            else if (g) cur.e.Page = g[1]
            else if (t) cur.e.Title = t[1]
            else if (/^\s+\},?\s*$/.test(line) && depth === 2) {
                map.set(cur.key, /** @type {{Path: string, Page: string, Title: string}} */ (cur.e))
                cur = null
            }
        }
        depth += braces(line)
        if (depth <= 0) break
    }
    return map
}

/**
 * Map statically-imported view identifiers to their owning package
 * (`import { HomeView } from '@packages/booking_booking/views'`).
 * @param {string} src routes.ts content
 * @returns {Map<string, string>} importName → package short name
 */
export function parseStaticImports(src) {
    const map = new Map()
    const re = /import\s*\{([^}]*)\}\s*from\s*'@packages\/([^'/]+)\/[^']*'/g
    let m
    while ((m = re.exec(src))) {
        const pkg = m[2]
        for (const name of m[1].split(',').map((s) => s.trim()).filter(Boolean)) map.set(name, pkg)
    }
    return map
}

/**
 * Parse local `const NAME = '...'` string constants (e.g. ROOT, CATCH_ALL) from routes.ts.
 * @param {string} src
 * @returns {Map<string, string>}
 */
function parseLocalConsts(src) {
    const map = new Map()
    const re = /^const\s+([A-Z0-9_]+)\s*=\s*'([^']*)'/gm
    let m
    while ((m = re.exec(src))) map.set(m[1], m[2])
    return map
}

/**
 * Resolve a raw `path:` value to a literal.
 * @param {string} raw e.g. "ROUTER_PATH.Home.Path", "ROOT", "''", "'invoice'"
 * @param {Map<string, {Path: string}>} routerPath
 * @param {Map<string, string>} localConsts
 * @returns {{ok: boolean, literal?: string, key?: string|null}}
 */
function resolvePath(raw, routerPath, localConsts) {
    let m = raw.match(/^ROUTER_PATH\.([A-Za-z0-9_]+)\.Path$/)
    if (m) {
        const e = routerPath.get(m[1])
        return e ? { ok: true, literal: e.Path, key: m[1] } : { ok: false }
    }
    if (localConsts.has(raw)) return { ok: true, literal: /** @type {string} */ (localConsts.get(raw)), key: raw }
    m = raw.match(/^'([^']*)'$/)
    if (m) return { ok: true, literal: m[1], key: null }
    return { ok: false }
}

/**
 * Join a parent route path with a child segment (`''` child → parent; absolute child → itself).
 * @param {string} parent
 * @param {string} child
 * @returns {string}
 */
function joinPath(parent, child) {
    if (child === '') return parent || '/'
    if (child.startsWith('/')) return child
    return `${parent.replace(/\/$/, '')}/${child}`
}

/**
 * Parse the route table. Throws {@link RouteMapError} if any `path:` line fails to resolve
 * (the D12 self-check) so the caller writes nothing on drift.
 * @param {string} routesSrc routes.ts content
 * @param {string} constantsSrc constants.ts content
 * @returns {{routes: Array<{path: string, name: string, view: string, pkg: string, guard: string}>, total: number}}
 */
export function parseRoutes(routesSrc, constantsSrc) {
    const routerPath = parseRouterPath(constantsSrc)
    const staticImports = parseStaticImports(routesSrc)
    const localConsts = parseLocalConsts(routesSrc)

    // Parse ONLY the exported route array. This excludes helper code above it (the navigation
    // guards contain `next({ path: ... })` decoys that are not routes) and lets a plain
    // `\bpath:` count inside the array act as an independent drift check against the parser.
    const arrayAt = routesSrc.search(/export\s+default\s*\[/)
    if (arrayAt === -1) throw new RouteMapError('could not find "export default [" route array in routes.ts')
    const body = routesSrc.slice(arrayAt)
    const independentPathCount = (body.match(/\bpath:/g) || []).length

    const lines = body.split('\n')
    /** @type {Array<{indent: number, full: string, name: string, view: string, pkg: string, guard: string, ok: boolean}>} */
    const routes = []
    /** @type {Array<{indent: number, full: string}>} */
    const stack = []
    let cur = null
    let total = 0

    for (const line of lines) {
        const pm = line.match(/^(\s*)path:\s*(.+?),?\s*$/)
        if (pm) {
            total++
            const indent = pm[1].length
            const r = resolvePath(pm[2].trim(), routerPath, localConsts)
            while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop()
            const parent = stack[stack.length - 1]
            const full = r.ok ? joinPath(parent?.full ?? '', /** @type {string} */ (r.literal)) : ''
            cur = { indent, full, name: '', view: '', pkg: '', guard: '', ok: r.ok }
            routes.push(cur)
            stack.push({ indent, full })
            continue
        }
        if (!cur) continue
        const nm = line.match(/name:\s*ROUTER_PATH\.([A-Za-z0-9_]+)\.Page/)
        if (nm) {
            cur.name = routerPath.get(nm[1])?.Page ?? nm[1]
            continue
        }
        const lazy = line.match(/component:\s*\(\)\s*=>\s*import\('@packages\/([^'/]+)\/[^']*'\)\s*\.then\([^)]*\)\s*=>\s*[A-Za-z0-9_]+\.([A-Za-z0-9_]+)\)/)
        if (lazy) {
            cur.pkg = lazy[1]
            cur.view = lazy[2]
            continue
        }
        const stat = line.match(/^\s*component:\s*([A-Za-z0-9_]+),?\s*$/)
        if (stat) {
            cur.view = stat[1]
            cur.pkg = staticImports.get(stat[1]) ?? ''
            continue
        }
        const be = line.match(/^\s*beforeEnter:\s*([A-Za-z0-9_]+),?\s*$/)
        if (be) {
            cur.guard = be[1]
            continue
        }
        if (/^\s*redirect:/.test(line) && !cur.view) cur.view = '(redirect)'
    }

    const resolved = routes.filter((r) => r.ok)
    if (total === 0) throw new RouteMapError('no route entries found in routes.ts')
    if (total !== independentPathCount)
        throw new RouteMapError(
            `route self-check failed: parser saw ${total} path: fields but the array contains ${independentPathCount} — parser drift, refusing to write`,
        )
    if (resolved.length !== total)
        throw new RouteMapError(
            `route self-check failed: resolved ${resolved.length} of ${total} path: entries — unrecognized route shape, refusing to write a partial map`,
        )
    return {
        routes: resolved.map((r) => ({ path: r.full, name: r.name, view: r.view, pkg: r.pkg, guard: r.guard })),
        total,
    }
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
 * Render the `map/routes.md` T0 document. Route order follows routes.ts (deterministic, keeps
 * parent/child grouping) — clean diffs without scattering children, as D4 requires.
 * @param {Array<{path: string, name: string, view: string, pkg: string, guard: string}>} routes
 * @param {{derived: string, harvested: string, version: string}} meta
 * @param {string} [routesFile] repo-relative routes path (stack default when omitted)
 * @param {string} [constantsFile] repo-relative constants path (stack default when omitted)
 * @returns {string}
 */
export function renderRoutesDoc(routes, meta, routesFile = ROUTES_FILE, constantsFile = CONSTANTS_FILE) {
    const fields = {
        id: 'map/routes',
        type: 'map', // OKF type (== layer); stamped for in-place conformance
        title: 'Route map — path → view → package',
        sources: [`file:${routesFile}`, `file:${constantsFile}`],
        derived_from_commit: meta.derived,
        harvested: meta.harvested,
        engine: `route-map@${meta.version}`,
        tickets: [],
        trust: 'T0',
        checks: [],
        schema_version: '1',
    }
    const rows = routes.map((r) => `| ${esc(r.path)} | ${esc(r.name)} | ${esc(r.view)} | ${esc(r.pkg)} | ${esc(r.guard)} |`)
    const body = [
        '',
        '## Routes',
        `<!-- sources: file:${routesFile}, file:${constantsFile} -->`,
        '<!-- trust: T0 -->',
        '',
        `${routes.length} routes (lazy views resolve to \`@packages/<pkg>/views\`).`,
        '',
        '| path | name | view | package | guard |',
        '|---|---|---|---|---|',
        ...rows,
        '',
    ].join('\n')
    return serializeFrontmatter(fields, body) + '\n'
}

/**
 * Read, parse, and render the route map from a repo. Throws {@link RouteMapError} on drift.
 * The file locations are CONFIG, not code (engine-vs-data principle, v0.3.0): the constants
 * above are only the Vue/Nx STACK defaults, overridable per store via `map.routesFile` /
 * `map.constantsFile`.
 * @param {string} repo repo toplevel
 * @param {{derived: string, harvested: string, version: string}} meta
 * @param {{routesFile?: string, constantsFile?: string}} [opts]
 * @returns {{content: string, routeCount: number}}
 */
export function buildRouteMap(repo, meta, { routesFile = ROUTES_FILE, constantsFile = CONSTANTS_FILE } = {}) {
    const routesPath = path.join(repo, routesFile)
    const constantsPath = path.join(repo, constantsFile)
    if (!existsSync(routesPath)) throw new RouteMapError(`routes file not found: ${routesFile}`)
    if (!existsSync(constantsPath)) throw new RouteMapError(`constants file not found: ${constantsFile}`)
    const { routes, total } = parseRoutes(readFileSync(routesPath, 'utf8'), readFileSync(constantsPath, 'utf8'))
    return { content: renderRoutesDoc(routes, meta, routesFile, constantsFile), routeCount: total }
}
