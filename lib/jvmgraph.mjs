/**
 * L0 JVM module-graph adapter (the JVM analog of the package graph).
 *
 * Best-effort build-file parse — NOT a gradle/maven invocation. Gradle: `include`
 * statements in settings.gradle(.kts) give the module list; `project(':x')` references in
 * each module's build.gradle(.kts) give module-dependency edges. Maven: `<modules>` in the
 * root pom gives the list; edges come from module-pom `<dependency>` entries whose groupId
 * matches the root groupId (best-effort — absent = just the module list). The build root
 * may sit at the repo toplevel OR exactly one level down (its location is noted in the doc).
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { serializeFrontmatter } from './frontmatter.mjs'

const SKIP_DIRS = new Set(['node_modules', '.git', 'build', 'target', 'out', '.gradle'])
const ROOT_FILES = ['settings.gradle', 'settings.gradle.kts', 'pom.xml']

/** Thrown when no gradle/maven build root exists (stack absence — the caller may skip). */
export class JvmGraphError extends Error {
    /** @param {string} message */
    constructor(message) {
        super(message)
        this.code = 'KAUT_JVMGRAPH'
    }
}

/**
 * Find the build root: settings.gradle(.kts) or pom.xml at the repo toplevel or exactly
 * one level down (first found wins, toplevel first, subdirs in sorted order).
 * @param {string} repo repo toplevel
 * @returns {{dir: string, file: string}|null} dir = repo-relative ('' = toplevel)
 */
export function findBuildRoot(repo) {
    for (const f of ROOT_FILES) if (existsSync(path.join(repo, f))) return { dir: '', file: f }
    let entries
    try {
        entries = readdirSync(repo, { withFileTypes: true })
    } catch {
        return null
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (!e.isDirectory() || SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue
        for (const f of ROOT_FILES)
            if (existsSync(path.join(repo, e.name, f))) return { dir: e.name, file: f }
    }
    return null
}

/**
 * Parse gradle `include` statements (`include ':a', ':b'` and `include(":a")` forms).
 * @param {string} src settings.gradle(.kts) content
 * @returns {string[]} module ids without the leading colon (nested keep inner colons)
 */
export function parseGradleIncludes(src) {
    const modules = []
    const stmt = /^\s*include\b([^\n]*)/gm
    let m
    while ((m = stmt.exec(src))) {
        const tok = /['"]:?([A-Za-z0-9_:.-]+)['"]/g
        let t
        while ((t = tok.exec(m[1]))) modules.push(t[1])
    }
    return [...new Set(modules)].sort()
}

/**
 * Collect `project(':x')` references from a gradle build file.
 * @param {string} src build.gradle(.kts) content
 * @returns {string[]} referenced module ids without the leading colon
 */
export function parseGradleProjectRefs(src) {
    const out = new Set()
    const re = /\bproject\s*\(\s*['"]:?([A-Za-z0-9_:.-]+)['"]\s*\)/g
    let m
    while ((m = re.exec(src))) out.add(m[1])
    return [...out].sort()
}

/**
 * Parse the maven module list and root groupId from the root pom.
 * @param {string} src root pom.xml content
 * @returns {{modules: string[], groupId: string|null}}
 */
export function parseMavenRoot(src) {
    const modules = []
    const re = /<module>([^<]+)<\/module>/g
    let m
    while ((m = re.exec(src))) modules.push(m[1].trim())
    // Root groupId: the first one OUTSIDE <parent> (fall back to the parent's).
    const own = src.replace(/<parent>[\s\S]*?<\/parent>/, '').match(/<groupId>([^<]+)<\/groupId>/)
    const any = src.match(/<groupId>([^<]+)<\/groupId>/)
    return { modules: [...new Set(modules)].sort(), groupId: (own ?? any)?.[1].trim() ?? null }
}

/**
 * Build the module graph from a repo.
 * @param {string} repo repo toplevel
 * @returns {{buildRoot: {dir: string, file: string},
 *   modules: Array<{name: string, path: string, deps: string[]}>,
 *   readFiles: string[]}} readFiles = repo-relative build files actually read (sorted)
 */
export function parseJvmGraph(repo) {
    const root = findBuildRoot(repo)
    if (!root) throw new JvmGraphError('no gradle/maven build root found (settings.gradle(.kts)/pom.xml at top or one level down)')
    const rootRel = root.dir ? `${root.dir}/${root.file}` : root.file
    const rootSrc = readFileSync(path.join(repo, rootRel), 'utf8')
    const readFiles = [rootRel]
    const modules = []

    if (root.file === 'pom.xml') {
        const { modules: names, groupId } = parseMavenRoot(rootSrc)
        const known = new Set(names)
        for (const name of names) {
            const rel = [root.dir, name, 'pom.xml'].filter(Boolean).join('/')
            const deps = new Set()
            if (existsSync(path.join(repo, rel))) {
                readFiles.push(rel)
                const src = readFileSync(path.join(repo, rel), 'utf8')
                const dep = /<dependency>([\s\S]*?)<\/dependency>/g
                let m
                while ((m = dep.exec(src))) {
                    const g = m[1].match(/<groupId>([^<]+)<\/groupId>/)?.[1].trim()
                    const a = m[1].match(/<artifactId>([^<]+)<\/artifactId>/)?.[1].trim()
                    if (g && a && g === groupId && known.has(a) && a !== name) deps.add(a)
                }
            }
            modules.push({ name, path: [root.dir, name].filter(Boolean).join('/'), deps: [...deps].sort() })
        }
    } else {
        const names = parseGradleIncludes(rootSrc)
        // A settings file with no includes is a legitimate SINGLE-module build — the
        // root project is the one module (a "0 modules" map on a real repo is noise).
        if (names.length === 0) {
            const named = /rootProject\.name\s*=\s*['"]([^'"]+)['"]/.exec(rootSrc)
            const rootName = named ? named[1] : path.basename(root.dir ? path.join(repo, root.dir) : repo)
            modules.push({ name: rootName, path: root.dir || '.', deps: [] })
        }
        const known = new Set(names)
        for (const name of names) {
            const modPath = [root.dir, ...name.split(':')].filter(Boolean).join('/')
            const deps = new Set()
            for (const bf of ['build.gradle', 'build.gradle.kts']) {
                const rel = `${modPath}/${bf}`
                if (!existsSync(path.join(repo, rel))) continue
                readFiles.push(rel)
                for (const ref of parseGradleProjectRefs(readFileSync(path.join(repo, rel), 'utf8')))
                    if (known.has(ref) && ref !== name) deps.add(ref)
            }
            modules.push({ name, path: modPath, deps: [...deps].sort() })
        }
    }
    modules.sort((a, b) => a.name.localeCompare(b.name))
    return { buildRoot: root, modules, readFiles: readFiles.sort() }
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
 * Render the `map/packages.md` T0 document (same doc id the JS package graph uses — a repo
 * has ONE package map, produced by whichever collector its stack selects).
 * @param {ReturnType<typeof parseJvmGraph>} graph
 * @param {{derived: string, harvested: string, version: string}} meta
 * @returns {string}
 */
export function renderJvmPackagesDoc(graph, meta) {
    const sources = graph.readFiles.map((f) => `file:${f}`)
    const fields = {
        id: 'map/packages',
        type: 'map', // OKF type (== layer); stamped for in-place conformance
        title: 'Package graph — JVM build modules',
        sources,
        derived_from_commit: meta.derived,
        harvested: meta.harvested,
        engine: `jvm-graph@${meta.version}`,
        tickets: [],
        trust: 'T0',
        checks: [],
        schema_version: '1',
    }
    const rootRel = graph.buildRoot.dir
        ? `${graph.buildRoot.dir}/${graph.buildRoot.file}`
        : graph.buildRoot.file
    const rows = graph.modules.map(
        (m) => `| ${esc(m.name)} | ${esc(m.path)} | ${m.deps.length ? esc(m.deps.join(', ')) : '(none)'} |`,
    )
    const edges = []
    for (const m of graph.modules) for (const d of m.deps) edges.push(`- ${m.name} → ${d}`)
    edges.sort()
    const body = [
        '',
        '## Modules',
        `<!-- sources: ${sources.join(', ')} -->`,
        '<!-- trust: T0 -->',
        '',
        `${graph.modules.length} modules. Build root: \`${rootRel}\`${graph.buildRoot.dir ? ' (nested one level down)' : ' (repo toplevel)'}.`,
        'Best-effort build-file parse (no gradle/maven invocation); edges come from',
        "`project(':x')` references (gradle) or same-groupId dependencies (maven).",
        '',
        '| module | path | deps |',
        '|---|---|---|',
        ...rows,
        '',
        '## Edges',
        '',
        ...(edges.length ? edges : ['(none)']),
        '',
    ].join('\n')
    return serializeFrontmatter(fields, body) + '\n'
}

/**
 * Find, parse, and render the JVM module graph from a repo. Throws {@link JvmGraphError}
 * when no build root exists (stack absence — distinguishable, skippable).
 * @param {string} repo repo toplevel
 * @param {{derived: string, harvested: string, version: string}} meta
 * @param {object} [opts] reserved (no overrides yet — the build root is auto-located)
 * @returns {{content: string, moduleCount: number}}
 */
export function buildJvmGraph(repo, meta, opts = {}) {
    const graph = parseJvmGraph(repo)
    return { content: renderJvmPackagesDoc(graph, meta), moduleCount: graph.modules.length }
}
