/**
 * Stack auto-detection for bootstrap (map-collector selection).
 *
 * Cheap filesystem probes only — package/composer/python manifests read at the toplevel,
 * build files probed at most one level down, bounded content scans that stop at the first hit.
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
    'routemap', 'pkggraph', 'nextroutes', 'springmap', 'jvmgraph', 'pymap',
    'sqlmigrations', 'httproutes', 'phproutes', 'composemap',
]
const FLYWAY_RE = /^V\d+(?:[._]\d+)*__.+\.sql$/
const DJANGO_MIGRATION_RE = /^\d{4}_.+\.py$/
/** Python dependency manifests / lock files read (lowercased) for framework labels. */
const PY_MANIFESTS = [
    'pyproject.toml', 'requirements.txt', 'setup.py', 'setup.cfg', 'Pipfile', 'Pipfile.lock',
    'environment.yml', 'uv.lock', 'poetry.lock', 'pdm.lock',
]
/** Python web frameworks whose route idioms the `httproutes` lexical scan covers. */
const PY_FRAMEWORKS = [
    ['fastapi', 'fastapi'], ['starlette', 'starlette'], ['flask', 'flask'], ['quart', 'quart'],
    ['django', 'django'], ['djangorestframework', 'drf'], ['django-ninja', 'django-ninja'],
    ['aiohttp', 'aiohttp'], ['sanic', 'sanic'], ['litestar', 'litestar'], ['tornado', 'tornado'],
    ['bottle', 'bottle'], ['falcon', 'falcon'], ['pyramid', 'pyramid'],
]

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
 * Sorted file names directly inside a directory; [] on absence.
 * @param {string} abs
 * @returns {string[]}
 */
function files(abs) {
    try {
        return readdirSync(abs, { withFileTypes: true })
            .filter((e) => e.isFile())
            .map((e) => e.name)
            .sort()
    } catch {
        return []
    }
}

/**
 * Read every Python dependency manifest present at the toplevel (plus `requirements*.txt`
 * and `requirements/*.txt`), lowercased and `_`→`-` normalized for name matching.
 * @param {string} repo
 * @returns {{present: string[], text: string}} present = manifests found (repo-relative)
 */
function pythonManifests(repo) {
    const present = []
    const rootFiles = files(repo)
    for (const f of rootFiles)
        if (PY_MANIFESTS.includes(f) || /^requirements[\w.-]*\.txt$/.test(f)) present.push(f)
    for (const f of files(path.join(repo, 'requirements'))) if (f.endsWith('.txt')) present.push(`requirements/${f}`)
    let text = ''
    for (const f of present)
        try {
            text += readFileSync(path.join(repo, f), 'utf8').toLowerCase().replaceAll('_', '-') + '\n'
        } catch {
            /* unreadable — skip */
        }
    return { present: [...new Set(present)].sort(), text }
}

/**
 * Does the repo carry plain Python scripts (`*.py` at the toplevel or under `scripts/` / `bin/`)?
 * @param {string} repo
 * @returns {boolean}
 */
function hasPythonScripts(repo) {
    return ['', 'scripts', 'bin'].some((d) => files(path.join(repo, d)).some((f) => f.endsWith('.py')))
}

/**
 * Is this an Alembic revision file? (`revision =` assignment near the top; read on demand).
 * @param {string} abs
 * @returns {boolean}
 */
function isAlembicRevision(abs) {
    try {
        return /^\s*revision(?:\s*:\s*str)?\s*=\s*['"]/m.test(readFileSync(abs, 'utf8'))
    } catch {
        return false
    }
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

    // Generic HTTP backends: JS server frameworks in package.json (python ones below).
    for (const [dep, label] of [['express', 'express'], ['fastify', 'fastify'], ['@nestjs/core', 'nestjs']])
        if (dep in deps) {
            picked.add('httproutes')
            stack.push(label)
        }

    // Python: any dependency manifest / lock file at the toplevel, or plain scripts. The
    // package/script map applies to every Python repo; web frameworks named in the
    // manifests (word-boundary match on normalized names) add the lexical route scan.
    const py = pythonManifests(repo)
    if (py.present.length || hasPythonScripts(repo)) {
        picked.add('pymap')
        stack.push(py.present.length ? 'python' : 'python-scripts')
        const named = new Set()
        // Boundary = any non-alphanumeric, so extensions and plugins count for their framework
        // (`flask-restx` → flask, `pytest-django` → django) while `flasky` does not.
        for (const [dep, label] of PY_FRAMEWORKS) if (new RegExp(`(^|[^a-z0-9])${dep}([^a-z0-9]|$)`, 'm').test(py.text)) named.add(label)
        if (existsSync(path.join(repo, 'manage.py'))) named.add('django')
        for (const [, label] of PY_FRAMEWORKS)
            if (named.has(label)) {
                picked.add('httproutes')
                stack.push(label)
            }
        // Python migrations: Django (`migrations/NNNN_*.py`) and Alembic (`versions/*.py`
        // carrying a `revision =` assignment) — bounded scans, first hit ends each.
        if (anyFile(repo, 5, (name, abs) => DJANGO_MIGRATION_RE.test(name) && path.basename(path.dirname(abs)) === 'migrations')) {
            picked.add('sqlmigrations')
            stack.push('django-migrations')
        }
        if (anyFile(repo, 5, (name, abs) => name.endsWith('.py') && path.basename(path.dirname(abs)) === 'versions' && isAlembicRevision(abs))) {
            picked.add('sqlmigrations')
            stack.push('alembic')
        }
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
