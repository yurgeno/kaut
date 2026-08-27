/**
 * L0 spring route-map adapter.
 *
 * Lexical best-effort scan over `**​/*.java` and `**​/*.kt` for Spring MVC annotations —
 * `@RestController`/`@Controller` classes, class-level `@RequestMapping` bases, and the
 * per-method `@GetMapping`/`@PostMapping`/… shortcuts plus `@RequestMapping(method =
 * RequestMethod.X)`. Kotlin annotations are syntactically identical, so one pass covers
 * both. This is NOT an AST: paths built from constants or SpEL render as the literal
 * expression text (the doc body says so). The scan starts at the repo toplevel, so a
 * gradle project root nested one level down is covered naturally.
 */
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { serializeFrontmatter } from './frontmatter.mjs'

const SKIP_DIRS = new Set(['node_modules', '.git', 'build', 'target', 'out', '.gradle'])
const SOURCE_RE = /\.(java|kt)$/

/** Thrown when the repo holds no Spring controllers (stack absence — the caller may skip). */
export class SpringMapError extends Error {
    /** @param {string} message */
    constructor(message) {
        super(message)
        this.code = 'KAUT_SPRINGMAP'
    }
}

/**
 * Recursively list `.java`/`.kt` files (sorted, skip list applied).
 * @param {string} repo repo toplevel
 * @returns {string[]} repo-relative `/`-separated paths
 */
function sourceFiles(repo) {
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
            } else if (SOURCE_RE.test(e.name)) out.push(rel ? `${rel}/${e.name}` : e.name)
        }
    }
    walk(repo, '')
    return out
}

/**
 * Extract the path argument from an annotation's argument text. Preference order:
 * `value = "…"` / `path = "…"` named argument, then the first string literal, then the raw
 * expression text (constants/SpEL — best-effort by design), then `''` for empty parens.
 * @param {string|undefined} args annotation argument text (without parens)
 * @returns {string}
 */
function extractPath(args) {
    if (!args || !args.trim()) return ''
    const named = args.match(/(?:value|path)\s*=\s*"([^"]*)"/)
    if (named) return named[1]
    const lit = args.match(/"([^"]*)"/)
    if (lit) return lit[1]
    // No string literal: render the expression text (method= clauses removed).
    return args.replace(/method\s*=\s*RequestMethod\.\w+\s*,?/g, '').replace(/,\s*$/, '').trim()
}

/**
 * Join a class-level base with a method-level path into one normalized route path.
 * @param {string} base
 * @param {string} sub
 * @returns {string}
 */
function joinPath(base, sub) {
    const joined = `/${base}/${sub}`.replace(/\/+/g, '/')
    return joined.length > 1 ? joined.replace(/\/$/, '') : joined
}

/**
 * Parse one controller file into route rows. Returns null when the file declares no
 * `@RestController`/`@Controller` class.
 * @param {string} src file content
 * @param {string} file repo-relative path (stamped into rows)
 * @returns {Array<{method: string, path: string, controller: string, file: string}>|null}
 */
export function parseSpringFile(src, file) {
    if (!/@(RestController|Controller)\b/.test(src)) return null
    const cls = src.match(/\b(?:class|interface)\s+([A-Za-z0-9_]+)/)
    const controller = cls ? cls[1] : '(unknown)'

    // Class-level base: the first @RequestMapping BEFORE the class keyword, without method=.
    const clsAt = cls ? src.indexOf(cls[0]) : src.length
    let base = ''
    const clsAnn = src.slice(0, clsAt).match(/@RequestMapping\s*(?:\(([^)]*)\))?/)
    if (clsAnn && !/method\s*=/.test(clsAnn[1] ?? '')) base = extractPath(clsAnn[1])

    const rows = []
    // Shortcut annotations: @GetMapping("/x"), @PostMapping(value = "/x"), bare @GetMapping.
    const shortcut = /@(Get|Post|Put|Delete|Patch)Mapping\s*(?:\(([^)]*)\))?/g
    let m
    while ((m = shortcut.exec(src)))
        rows.push({ method: m[1].toUpperCase(), path: joinPath(base, extractPath(m[2])), controller, file })
    // Long form: @RequestMapping(method = RequestMethod.X, …) — method-level only.
    const long = /@RequestMapping\s*\(([^)]*)\)/g
    while ((m = long.exec(src))) {
        const mm = m[1].match(/method\s*=\s*RequestMethod\.(\w+)/)
        if (mm) rows.push({ method: mm[1].toUpperCase(), path: joinPath(base, extractPath(m[1])), controller, file })
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
 * @param {Array<{method: string, path: string, controller: string, file: string}>} rows
 * @param {{derived: string, harvested: string, version: string}} meta
 * @returns {string}
 */
export function renderSpringRoutesDoc(rows, meta) {
    const fields = {
        id: 'map/routes',
        type: 'map', // OKF type (== layer); stamped for in-place conformance
        title: 'Route map — HTTP endpoints (spring)',
        sources: ['file-glob:**/*.java', 'file-glob:**/*.kt'],
        derived_from_commit: meta.derived,
        harvested: meta.harvested,
        engine: `spring-map@${meta.version}`,
        tickets: [],
        trust: 'T0',
        checks: [],
        schema_version: '1',
    }
    const table = rows.map((r) => `| ${esc(r.method)} | ${esc(r.path)} | ${esc(r.controller)} | ${esc(r.file)} |`)
    const body = [
        '',
        '## Routes',
        '<!-- sources: file-glob:**/*.java, file-glob:**/*.kt -->',
        '<!-- trust: T0 -->',
        '',
        `${rows.length} routes. Lexical annotation scan (not framework introspection): paths built`,
        'from constants or SpEL render as the literal expression text.',
        '',
        '| method | path | controller | file |',
        '|---|---|---|---|',
        ...table,
        '',
    ].join('\n')
    return serializeFrontmatter(fields, body) + '\n'
}

/**
 * Scan, parse, and render the spring route map from a repo. Throws {@link SpringMapError}
 * when the repo holds no controller classes (stack absence — distinguishable, skippable).
 * @param {string} repo repo toplevel
 * @param {{derived: string, harvested: string, version: string}} meta
 * @param {object} [opts] reserved (no overrides yet — the scan is convention-free)
 * @returns {{content: string, routeCount: number}}
 */
export function buildSpringMap(repo, meta, opts = {}) {
    const rows = []
    let controllers = 0
    for (const rel of sourceFiles(repo)) {
        const parsed = parseSpringFile(readFileSync(path.join(repo, rel), 'utf8'), rel)
        if (parsed === null) continue
        controllers++
        rows.push(...parsed)
    }
    if (controllers === 0)
        throw new SpringMapError('no spring controllers found (no @RestController/@Controller classes)')
    rows.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method) || a.file.localeCompare(b.file))
    return { content: renderSpringRoutesDoc(rows, meta), routeCount: rows.length }
}
