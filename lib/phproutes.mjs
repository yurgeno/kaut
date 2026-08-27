/**
 * L0 PHP route-map adapter.
 *
 * Lexical, line-based scan over `**​/*.php` covering the two dominant PHP routing styles:
 *   Laravel — `Route::get('/x', …)` / post|put|patch|delete|any, `Route::match(['get',
 *     'post'], '/x')` (one row per method), and `Route::resource('/x', …)` rendered as a
 *     single row with method `RESOURCE`;
 *   Symfony — `#[Route('/x', methods: ['GET', 'POST'])]` attributes (no methods = `ANY`)
 *     and legacy `@Route("/x", methods={"GET"})` docblock annotations.
 * This is a lexical scan, NOT framework introspection (the doc body says so): closures,
 * route groups/prefixes and multi-line declarations are not resolved.
 */
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { serializeFrontmatter } from './frontmatter.mjs'

const SKIP_DIRS = new Set(['vendor', 'node_modules', '.git', 'cache', 'var'])
const SKIP_RELS = ['storage/framework']

const LARAVEL_VERB = /\bRoute::(get|post|put|patch|delete|any)\s*\(\s*(['"])([^'"]*)\2/
const LARAVEL_MATCH = /\bRoute::match\s*\(\s*\[([^\]]*)\]\s*,\s*(['"])([^'"]*)\2/
const LARAVEL_RESOURCE = /\bRoute::resource\s*\(\s*(['"])([^'"]*)\1/
const SYMFONY_ATTR = /#\[\s*Route\s*\(\s*(['"])([^'"]*)\1(.*)$/
const SYMFONY_ANNO = /@Route\s*\(\s*"([^"]*)"(.*)$/

/** Thrown when the repo yields no PHP route matches (stack absence — the caller may skip). */
export class PhpRoutesError extends Error {
    /** @param {string} message */
    constructor(message) {
        super(message)
        this.code = 'KAUT_PHPROUTES'
    }
}

/**
 * Recursively list `.php` files (sorted, skip list applied).
 * @param {string} repo repo toplevel
 * @returns {string[]} repo-relative `/`-separated paths
 */
function phpFiles(repo) {
    const out = []
    const walk = (dir, rel) => {
        let entries
        try {
            entries = readdirSync(dir, { withFileTypes: true })
        } catch {
            return
        }
        for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
            const childRel = rel ? `${rel}/${e.name}` : e.name
            if (e.isDirectory()) {
                if (!SKIP_DIRS.has(e.name) && !SKIP_RELS.includes(childRel)) walk(path.join(dir, e.name), childRel)
            } else if (e.name.endsWith('.php')) out.push(childRel)
        }
    }
    walk(repo, '')
    return out
}

/**
 * Parse quoted method names out of a list body (`'get', "post"` / `"GET", "POST"`).
 * @param {string} listBody
 * @returns {string[]} upper-cased methods
 */
function methodList(listBody) {
    return [...listBody.matchAll(/['"](\w+)['"]/g)].map((m) => m[1].toUpperCase())
}

/**
 * Scan one file's content for route rows (line-based).
 * @param {string} src file content
 * @param {string} file repo-relative path
 * @returns {Array<{method: string, path: string, at: string}>} at = `file:line`
 */
export function scanPhpFile(src, file) {
    const rows = []
    const lines = src.split('\n')
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        const at = `${file}:${i + 1}`
        let m
        if ((m = line.match(LARAVEL_VERB))) {
            rows.push({ method: m[1].toUpperCase(), path: m[3], at })
        } else if ((m = line.match(LARAVEL_MATCH))) {
            for (const method of methodList(m[1])) rows.push({ method, path: m[3], at })
        } else if ((m = line.match(LARAVEL_RESOURCE))) {
            rows.push({ method: 'RESOURCE', path: m[2], at })
        } else if ((m = line.match(SYMFONY_ATTR))) {
            const methods = m[3].match(/methods\s*:\s*\[([^\]]*)\]/)
            for (const method of methods ? methodList(methods[1]) : ['ANY']) rows.push({ method, path: m[2], at })
        } else if ((m = line.match(SYMFONY_ANNO))) {
            const methods = m[2].match(/methods\s*=\s*\{([^}]*)\}/)
            for (const method of methods ? methodList(methods[1]) : ['ANY']) rows.push({ method, path: m[1], at })
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
export function renderPhpRoutesDoc(rows, meta) {
    const fields = {
        id: 'map/routes',
        type: 'map', // OKF type (== layer); stamped for in-place conformance
        title: 'Route map — HTTP endpoints (php)',
        sources: ['file-glob:**/*.php'],
        derived_from_commit: meta.derived,
        harvested: meta.harvested,
        engine: `php-routes@${meta.version}`,
        tickets: [],
        trust: 'T0',
        checks: [],
        schema_version: '1',
    }
    const table = rows.map((r) => `| ${esc(r.method)} | ${esc(r.path)} | ${esc(r.at)} |`)
    const body = [
        '',
        '## Routes',
        '<!-- sources: file-glob:**/*.php -->',
        '<!-- trust: T0 -->',
        '',
        `${rows.length} routes. This is a LEXICAL scan, not framework introspection: it greps`,
        'route-registration idioms (Laravel Route:: calls, Symfony #[Route] attributes and',
        'legacy @Route annotations) and does not resolve groups, prefixes or multi-line forms.',
        '',
        '| method | path | file:line |',
        '|---|---|---|',
        ...table,
        '',
    ].join('\n')
    return serializeFrontmatter(fields, body) + '\n'
}

/**
 * Scan and render the PHP route map from a repo. Throws {@link PhpRoutesError} when no
 * PHP files or no route matches exist (stack absence — distinguishable, skippable).
 * @param {string} repo repo toplevel
 * @param {{derived: string, harvested: string, version: string}} meta
 * @param {object} [opts] reserved (no overrides yet — the scan is convention-free)
 * @returns {{content: string, routeCount: number}}
 */
export function buildPhpRoutes(repo, meta, opts = {}) {
    const files = phpFiles(repo)
    if (files.length === 0) throw new PhpRoutesError('no PHP files found')
    const rows = []
    for (const rel of files) rows.push(...scanPhpFile(readFileSync(path.join(repo, rel), 'utf8'), rel))
    if (rows.length === 0) throw new PhpRoutesError('no php route registrations found (lexical scan)')
    rows.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method) || a.at.localeCompare(b.at))
    return { content: renderPhpRoutesDoc(rows, meta), routeCount: rows.length }
}
