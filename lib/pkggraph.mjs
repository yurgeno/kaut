/**
 * L0 package-graph adapter (SCHEMA §14).
 *
 * Deterministic import grep over `packages/<p>/src/**` — NOT an `nx graph` invocation. For
 * 18 packages a one-pass file scan is faster and dependency-free, and stays deterministic
 * (sorted output → clean git diffs). Edge weight = number of files in package `p` that import
 * package `q` (file-level machinery may later reuse this). Generated `src/api/**` is
 * intentionally included — its imports are real dependencies.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { serializeFrontmatter } from './frontmatter.mjs'

const PACKAGES_DIR = 'packages'
const SOURCE_RE = /\.(ts|mts|cts|vue)$/
/** Both static `from '@packages/q/…'` and dynamic `import('@packages/q/…')`, single or double quoted. */
const IMPORT_RE = /(?:from|import)\s*\(?\s*['"]@packages\/([^'"/]+)\//g

/**
 * List package directories (immediate children of `packages/` that contain a `src/`).
 * @param {string} repo repo toplevel
 * @returns {string[]} sorted package short names
 */
export function listPackages(repo, packagesDir = PACKAGES_DIR) {
    const dir = path.join(repo, packagesDir)
    if (!existsSync(dir)) return []
    return readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && existsSync(path.join(dir, e.name, 'src')))
        .map((e) => e.name)
        .sort()
}

/**
 * Recursively list source files under a directory.
 * @param {string} dir absolute directory
 * @returns {string[]} absolute file paths
 */
function sourceFiles(dir) {
    const out = []
    const walk = (d) => {
        for (const e of readdirSync(d, { withFileTypes: true })) {
            const p = path.join(d, e.name)
            if (e.isDirectory()) walk(p)
            else if (SOURCE_RE.test(e.name)) out.push(p)
        }
    }
    if (existsSync(dir) && statSync(dir).isDirectory()) walk(dir)
    return out
}

/**
 * Extract the distinct packages referenced by one file's imports.
 * @param {string} content
 * @returns {Set<string>}
 */
function referencedPackages(content) {
    const out = new Set()
    let m
    IMPORT_RE.lastIndex = 0
    while ((m = IMPORT_RE.exec(content))) out.add(m[1])
    return out
}

/**
 * Build the package dependency graph.
 * @param {string} repo repo toplevel
 * @returns {{packages: string[], edges: Array<{from: string, to: string, weight: number}>}}
 *   edges sorted by (from, to); weight = number of files in `from` importing `to`.
 */
export function parsePackageGraph(repo, packagesDir = PACKAGES_DIR) {
    const packages = listPackages(repo, packagesDir)
    const known = new Set(packages)
    /** @type {Map<string, Map<string, number>>} from → (to → file count) */
    const weights = new Map()

    for (const p of packages) {
        const counts = new Map()
        for (const file of sourceFiles(path.join(repo, packagesDir, p, 'src'))) {
            for (const q of referencedPackages(readFileSync(file, 'utf8'))) {
                if (q === p || !known.has(q)) continue // no self-edges; only real packages
                counts.set(q, (counts.get(q) ?? 0) + 1)
            }
        }
        weights.set(p, counts)
    }

    const edges = []
    for (const p of packages)
        for (const q of [...(weights.get(p)?.keys() ?? [])].sort())
            edges.push({ from: p, to: q, weight: /** @type {number} */ (weights.get(p)?.get(q)) })
    return { packages, edges }
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
 * Render `map/packages.md` (T0). One row per package (alphabetical): out-edges with weights and
 * the in-degree (how many packages import it).
 * @param {{packages: string[], edges: Array<{from: string, to: string, weight: number}>}} graph
 * @param {{derived: string, harvested: string, version: string}} meta
 * @returns {string}
 */
export function renderPackagesDoc(graph, meta, packagesDir = PACKAGES_DIR) {
    const fields = {
        id: 'map/packages',
        type: 'map', // OKF type (== layer); stamped for in-place conformance
        title: 'Package graph — @packages dependencies',
        sources: [`file-glob:${packagesDir}/*/src/**`, 'file:tsconfig.base.json'],
        derived_from_commit: meta.derived,
        harvested: meta.harvested,
        engine: `pkg-graph@${meta.version}`,
        tickets: [],
        trust: 'T0',
        checks: [],
        schema_version: '1',
    }
    const inDegree = new Map(graph.packages.map((p) => [p, 0]))
    for (const e of graph.edges) inDegree.set(e.to, (inDegree.get(e.to) ?? 0) + 1)

    const rows = graph.packages.map((p) => {
        const deps = graph.edges.filter((e) => e.from === p).map((e) => `${e.to}(${e.weight})`)
        return `| ${esc(p)} | ${deps.length ? esc(deps.join(', ')) : '(none)'} | ${inDegree.get(p)} |`
    })
    const body = [
        '',
        '## Packages',
        `<!-- sources: file-glob:${packagesDir}/*/src/**, file:tsconfig.base.json -->`,
        '<!-- trust: T0 -->',
        '',
        `${graph.packages.length} packages. "depends on" weight = files importing that package; "imported by" = in-degree.`,
        '',
        '| package | depends on | imported by |',
        '|---|---|---|',
        ...rows,
        '',
    ].join('\n')
    return serializeFrontmatter(fields, body) + '\n'
}

/**
 * Read, parse, and render the package map from a repo. The packages directory is CONFIG,
 * not code (engine-vs-data principle, v0.3.0): `PACKAGES_DIR` is only the Nx STACK default,
 * overridable per store via `map.packagesDir`.
 * @param {string} repo repo toplevel
 * @param {{derived: string, harvested: string, version: string}} meta
 * @param {{packagesDir?: string}} [opts]
 * @returns {{content: string, packageCount: number}}
 */
export function buildPackageGraph(repo, meta, { packagesDir = PACKAGES_DIR } = {}) {
    const graph = parsePackageGraph(repo, packagesDir)
    return { content: renderPackagesDoc(graph, meta, packagesDir), packageCount: graph.packages.length }
}
