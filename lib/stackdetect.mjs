/**
 * Stack auto-detection for bootstrap (map-collector selection).
 *
 * Cheap filesystem probes only — package/composer manifests read at the toplevel, build
 * files probed at most one level down, bounded content scans that stop at the first hit.
 * The result seeds `map.collectors` in a NEW kaut.config.json; an existing config is never
 * touched (the config is data, data is precious).
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'

const SKIP_DIRS = new Set([
    'node_modules', '.git', 'build', 'target', 'out', '.gradle',
    'venv', '.venv', '__pycache__', 'dist', 'vendor',
])
/** Canonical emit order — detection is set-valued, the output list must be deterministic. */
const COLLECTOR_ORDER = [
    'routemap', 'pkggraph', 'nextroutes', 'springmap', 'jvmgraph',
    'sqlmigrations', 'httproutes', 'phproutes', 'composemap',
]
const FLYWAY_RE = /^V\d+(?:[._]\d+)*__.+\.sql$/

/**
 * Read and parse a JSON file, or null on absence/parse failure (probes never throw).
 * @param {string} abs
 * @returns {object|null}
 */
function readJson(abs) {
    try {
        return JSON.parse(readFileSync(abs, 'utf8'))
    } catch {
        return null
    }
}

/**
 * Sorted subdirectory names (skip list and dot-dirs applied); [] on absence.
 * @param {string} abs
 * @returns {string[]}
 */
function subdirs(abs) {
    try {
        return readdirSync(abs, { withFileTypes: true })
            .filter((e) => e.isDirectory() && !SKIP_DIRS.has(e.name) && !e.name.startsWith('.'))
            .map((e) => e.name)
            .sort()
    } catch {
        return []
    }
}

/**
 * Bounded recursive probe: does any file below `repo` satisfy the predicate?
 * Stops at the first hit; descends at most `maxDepth` directory levels.
 * @param {string} repo
 * @param {number} maxDepth
 * @param {(name: string, abs: string) => boolean} match
 * @returns {boolean}
 */
function anyFile(repo, maxDepth, match) {
    const walk = (dir, depth) => {
        let entries
        try {
            entries = readdirSync(dir, { withFileTypes: true })
        } catch {
            return false
        }
        for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
            const abs = path.join(dir, e.name)
            if (e.isDirectory()) {
                if (depth < maxDepth && !SKIP_DIRS.has(e.name) && !e.name.startsWith('.') && walk(abs, depth + 1)) return true
            } else if (match(e.name, abs)) return true
        }
        return false
    }
    return walk(repo, 1)
}

/**
 * Does a file's content contain a Spring controller annotation? (read on demand,
 * first hit ends the whole scan via {@link anyFile}).
 * @param {string} abs
 * @returns {boolean}
 */
function isSpringController(abs) {
    try {
        return /@(RestController|Controller)\b/.test(readFileSync(abs, 'utf8'))
    } catch {
        return false
    }
}

/**
 * Probe a repo for known stacks and pick the matching map collectors.
 * Empty detection → `{collectors: [], stack: []}`.
 * @param {string} repo repo toplevel
 * @returns {{collectors: string[], stack: string[]}} collectors in canonical order;
 *   stack = human-readable labels for what was detected
 */
export function detectCollectors(repo) {
    const picked = new Set()
    const stack = []

    const pkg = readJson(path.join(repo, 'package.json'))
    const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) }

    // Vue router map: the vue dependency or the conventional routes file.
    const hasVueDep = 'vue' in deps
    const hasRoutesFile = existsSync(path.join(repo, 'src/router/routes.ts'))
    if (hasVueDep || hasRoutesFile) {
        picked.add('routemap')
        stack.push('vue')
    }

    // JS monorepo package graph: packages/<p>/src layout.
    if (subdirs(path.join(repo, 'packages')).some((p) => existsSync(path.join(repo, 'packages', p, 'src')))) {
        picked.add('pkggraph')
        stack.push('monorepo')
    }

    // Next.js file-based routing.
    const hasNextDep = 'next' in deps
    const hasNextDirs =
        ['app', 'src/app'].some((d) => ['js', 'jsx', 'ts', 'tsx'].some((x) => existsSync(path.join(repo, d, `page.${x}`)))) ||
        ['pages', 'src/pages'].some((d) => existsSync(path.join(repo, d)))
    if (hasNextDep || hasNextDirs) {
        picked.add('nextroutes')
        stack.push('next')
        // A routes-file-only vue hit is a false positive in a next repo — keep routemap
        // only when the vue dependency itself is present.
        if (!hasVueDep && picked.has('routemap')) {
            picked.delete('routemap')
            stack.splice(stack.indexOf('vue'), 1)
        }
    }

    // JVM build root at the toplevel or one level down (depth <= 2 for build files).
    const jvmRoots = [
        ['settings.gradle', 'jvm-gradle'],
        ['settings.gradle.kts', 'jvm-gradle'],
        ['pom.xml', 'jvm-maven'],
    ]
    let jvmLabel = null
    for (const [f, label] of jvmRoots) if (existsSync(path.join(repo, f))) jvmLabel = label
    if (!jvmLabel)
        for (const d of subdirs(repo)) {
            for (const [f, label] of jvmRoots) if (existsSync(path.join(repo, d, f))) jvmLabel = label
            if (jvmLabel) break
        }
    if (jvmLabel) {
        picked.add('jvmgraph')
        stack.push(jvmLabel)
        // Spring: any .java/.kt file with a controller annotation (stop at the first hit).
        if (anyFile(repo, 12, (name, abs) => /\.(java|kt)$/.test(name) && isSpringController(abs))) {
            picked.add('springmap')
            stack.push('spring')
        }
    }

    // Flyway-named SQL migrations anywhere at depth <= 4.
    if (anyFile(repo, 4, (name) => FLYWAY_RE.test(name))) {
        picked.add('sqlmigrations')
        stack.push('sql-migrations')
    }

    // Generic HTTP backends: JS server frameworks in package.json, python ones in the
    // dependency manifests at the toplevel.
    for (const [dep, label] of [['express', 'express'], ['fastify', 'fastify'], ['@nestjs/core', 'nestjs']])
        if (dep in deps) {
            picked.add('httproutes')
            stack.push(label)
        }
    let pyManifest = ''
    for (const f of ['requirements.txt', 'pyproject.toml'])
        try {
            pyManifest += readFileSync(path.join(repo, f), 'utf8').toLowerCase()
        } catch {
            /* absent — fine */
        }
    for (const label of ['fastapi', 'flask'])
        if (new RegExp(`\\b${label}\\b`).test(pyManifest)) {
            picked.add('httproutes')
            stack.push(label)
        }

    // PHP: composer.json at the toplevel (framework names are labels only — one collector).
    const composer = readJson(path.join(repo, 'composer.json'))
    if (composer) {
        picked.add('phproutes')
        stack.push('php')
        const req = { ...(composer.require ?? {}), ...(composer['require-dev'] ?? {}) }
        if ('laravel/framework' in req) stack.push('laravel')
        if ('symfony/framework-bundle' in req || 'symfony/routing' in req) stack.push('symfony')
    }

    // Compose topology.
    if (existsSync(path.join(repo, 'docker-compose.yml'))) {
        picked.add('composemap')
        stack.push('compose')
    }

    return { collectors: COLLECTOR_ORDER.filter((c) => picked.has(c)), stack }
}
