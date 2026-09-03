/**
 * L0 Python package/script map adapter (the Python analog of the package graph).
 *
 * Deterministic filesystem + import grep — NOT a `pip`/`python` invocation. Packages are
 * the top-level directories carrying an `__init__.py` (repo root, `src/` layout, or a
 * Django project folder one level down — the one holding `manage.py`);
 * scripts are the `*.py` files at the repo root and under `scripts/` / `bin/`; entry
 * points come from a best-effort line parse of `pyproject.toml` (`[project.scripts]`,
 * `[project.gui-scripts]`, `[tool.poetry.scripts]`) and `setup.cfg` (`console_scripts`).
 * Edge weight = number of files in package `p` importing package `q` (absolute imports
 * only — relative imports never cross a top-level package). Namespace packages (a
 * directory without `__init__.py`) are deliberately not listed; the doc says so.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { serializeFrontmatter } from './frontmatter.mjs'

const SKIP_DIRS = new Set([
    'node_modules', '.git', 'build', 'dist', 'target', 'out',
    'venv', '.venv', 'env', '.env', '__pycache__', 'site-packages', '.tox', '.nox',
    '.mypy_cache', '.pytest_cache', '.ruff_cache', '.eggs',
])
const PACKAGE_ROOTS = ['', 'src']
const PROJECT_MARKER = 'manage.py' // a Django project folder one level down is a package root too
const SCRIPT_DIRS = ['', 'scripts', 'bin']
const IMPORT_RE = /^\s*(?:from\s+([A-Za-z_][\w.]*)\s+import\b|import\s+([A-Za-z_][\w.]*(?:\s*,\s*[A-Za-z_][\w.]*)*))/
const MAIN_RE = /__name__\s*==\s*['"]__main__['"]/

/** Thrown when the repo holds no python packages or scripts (stack absence — the caller may skip). */
export class PyMapError extends Error {
    /** @param {string} message */
    constructor(message) {
        super(message)
        this.code = 'KAUT_PYMAP'
    }
}

/**
 * Sorted directory entries, or [] on absence (probes never throw).
 * @param {string} abs
 * @returns {import('node:fs').Dirent[]}
 */
function entries(abs) {
    try {
        return readdirSync(abs, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
    } catch {
        return []
    }
}

/**
 * Package roots: the repo toplevel, `src/`, and any directory one level down holding a
 * `manage.py` (a Django project kept in a subfolder — `backend/manage.py`).
 * @param {string} repo repo toplevel
 * @returns {string[]} repo-relative roots ('' = toplevel)
 */
export function packageRoots(repo) {
    const roots = [...PACKAGE_ROOTS]
    for (const e of entries(repo)) {
        if (!e.isDirectory() || SKIP_DIRS.has(e.name) || e.name.startsWith('.') || roots.includes(e.name)) continue
        if (existsSync(path.join(repo, e.name, PROJECT_MARKER))) roots.push(e.name)
    }
    return roots
}

/**
 * List top-level packages: `<root>/<name>/__init__.py` for every package root.
 * A name found at several roots keeps the first (toplevel, then `src/`).
 * @param {string} repo repo toplevel
 * @returns {Array<{name: string, path: string, django: boolean}>} sorted by name;
 *   django = the directory is a Django app (carries `apps.py`)
 */
export function listPythonPackages(repo) {
    const seen = new Map()
    for (const root of packageRoots(repo)) {
        for (const e of entries(path.join(repo, root))) {
            if (!e.isDirectory() || SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue
            const rel = root ? `${root}/${e.name}` : e.name
            if (!existsSync(path.join(repo, rel, '__init__.py')) || seen.has(e.name)) continue
            const django = existsSync(path.join(repo, rel, 'apps.py'))
            seen.set(e.name, { name: e.name, path: rel, django })
        }
    }
    return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * List scripts: `*.py` directly at the repo root and under `scripts/` / `bin/`.
 * @param {string} repo repo toplevel
 * @returns {Array<{file: string, main: boolean}>} sorted by path; main = has a
 *   `__main__` guard
 */
export function listPythonScripts(repo) {
    const out = []
    for (const dir of SCRIPT_DIRS) {
        for (const e of entries(path.join(repo, dir))) {
            if (!e.isFile() || !e.name.endsWith('.py')) continue
            const rel = dir ? `${dir}/${e.name}` : e.name
            let main = false
            try {
                main = MAIN_RE.test(readFileSync(path.join(repo, rel), 'utf8'))
            } catch {
                /* unreadable — listed without the flag */
            }
            out.push({ file: rel, main })
        }
    }
    return out.sort((a, b) => a.file.localeCompare(b.file))
}

/**
 * Parse `name = "target"` lines of the entry-point tables in pyproject.toml.
 * @param {string} src pyproject.toml content
 * @returns {Array<{name: string, target: string}>}
 */
export function parsePyprojectScripts(src) {
    const out = []
    const wanted = new Set(['project.scripts', 'project.gui-scripts', 'tool.poetry.scripts'])
    let inTable = false
    for (const raw of src.split('\n')) {
        const line = raw.trim()
        const head = line.match(/^\[([^\]]+)\]$/)
        if (head) {
            inTable = wanted.has(head[1].trim().replaceAll(/\s/g, ''))
            continue
        }
        if (!inTable) continue
        const kv = line.match(/^([A-Za-z0-9_."'-]+)\s*=\s*(['"])([^'"]+)\2/)
        if (kv) out.push({ name: kv[1].replaceAll(/['"]/g, ''), target: kv[3] })
    }
    return out
}

/**
 * Parse the `console_scripts` block of setup.cfg (`name = target` lines, indented).
 * @param {string} src setup.cfg content
 * @returns {Array<{name: string, target: string}>}
 */
export function parseSetupCfgScripts(src) {
    const out = []
    let inBlock = false
    for (const raw of src.split('\n')) {
        if (/^\s*console_scripts\s*=/.test(raw)) {
            inBlock = true
            const rest = raw.split('=').slice(1).join('=').trim()
            const kv = rest.match(/^([\w.-]+)\s*=\s*(\S+)/)
            if (kv) out.push({ name: kv[1], target: kv[2] })
            continue
        }
        if (!inBlock) continue
        if (!/^\s+\S/.test(raw)) {
            inBlock = false
            continue
        }
        const kv = raw.trim().match(/^([\w.-]+)\s*=\s*(\S+)/)
        if (kv) out.push({ name: kv[1], target: kv[2] })
    }
    return out
}

/**
 * Recursively list `.py` files under a directory (skip list applied).
 * @param {string} dir absolute directory
 * @returns {string[]} absolute paths
 */
function pyFiles(dir) {
    const out = []
    const walk = (d) => {
        for (const e of entries(d)) {
            const p = path.join(d, e.name)
            if (e.isDirectory()) {
                if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) walk(p)
            } else if (e.name.endsWith('.py')) out.push(p)
        }
    }
    if (existsSync(dir) && statSync(dir).isDirectory()) walk(dir)
    return out
}

/**
 * Distinct top-level module names a file imports absolutely (`import a.b`, `from a import`).
 * @param {string} content
 * @returns {Set<string>}
 */
export function importedTopLevel(content) {
    const out = new Set()
    for (const line of content.split('\n')) {
        const m = line.match(IMPORT_RE)
        if (!m) continue
        const names = m[1] ? [m[1]] : m[2].split(',').map((s) => s.trim())
        for (const n of names) out.add(n.split('.')[0])
    }
    return out
}

/**
 * Build the whole Python map: packages, import edges, scripts, entry points.
 * @param {string} repo repo toplevel
 * @returns {{packages: ReturnType<typeof listPythonPackages>,
 *   edges: Array<{from: string, to: string, weight: number}>,
 *   scripts: ReturnType<typeof listPythonScripts>,
 *   entryPoints: Array<{name: string, target: string, from: string}>,
 *   readFiles: string[]}} readFiles = repo-relative manifests actually read (sorted)
 */
export function parsePyMap(repo) {
    const packages = listPythonPackages(repo)
    const known = new Set(packages.map((p) => p.name))
    const edges = []
    for (const p of packages) {
        const counts = new Map()
        for (const file of pyFiles(path.join(repo, p.path))) {
            let content
            try {
                content = readFileSync(file, 'utf8')
            } catch {
                continue
            }
            for (const q of importedTopLevel(content)) {
                if (q === p.name || !known.has(q)) continue
                counts.set(q, (counts.get(q) ?? 0) + 1)
            }
        }
        for (const q of [...counts.keys()].sort()) edges.push({ from: p.name, to: q, weight: counts.get(q) })
    }

    const scripts = listPythonScripts(repo)
    const entryPoints = []
    const readFiles = []
    const pyproject = path.join(repo, 'pyproject.toml')
    if (existsSync(pyproject)) {
        readFiles.push('pyproject.toml')
        for (const ep of parsePyprojectScripts(readFileSync(pyproject, 'utf8'))) entryPoints.push({ ...ep, from: 'pyproject.toml' })
    }
    const setupCfg = path.join(repo, 'setup.cfg')
    if (existsSync(setupCfg)) {
        readFiles.push('setup.cfg')
        for (const ep of parseSetupCfgScripts(readFileSync(setupCfg, 'utf8'))) entryPoints.push({ ...ep, from: 'setup.cfg' })
    }
    entryPoints.sort((a, b) => a.name.localeCompare(b.name) || a.from.localeCompare(b.from))
    return { packages, edges, scripts, entryPoints, readFiles: readFiles.sort() }
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
 * Render the `map/packages.md` T0 document (same doc id the JS/JVM package graphs use — a
 * repo has ONE package map, produced by whichever collector its stack selects).
 * @param {ReturnType<typeof parsePyMap>} map
 * @param {{derived: string, harvested: string, version: string}} meta
 * @returns {string}
 */
export function renderPyMapDoc(map, meta) {
    const sources = ['file-glob:**/*.py', ...map.readFiles.map((f) => `file:${f}`)]
    const fields = {
        id: 'map/packages',
        type: 'map', // OKF type (== layer); stamped for in-place conformance
        title: 'Package map — Python packages & scripts',
        sources,
        derived_from_commit: meta.derived,
        harvested: meta.harvested,
        engine: `py-map@${meta.version}`,
        tickets: [],
        trust: 'T0',
        checks: [],
        schema_version: '1',
    }
    const inDegree = new Map(map.packages.map((p) => [p.name, 0]))
    for (const e of map.edges) inDegree.set(e.to, (inDegree.get(e.to) ?? 0) + 1)
    const pkgRows = map.packages.map((p) => {
        const deps = map.edges.filter((e) => e.from === p.name).map((e) => `${e.to}(${e.weight})`)
        return `| ${esc(p.name)}${p.django ? ' (django app)' : ''} | ${esc(p.path)} | ${deps.length ? esc(deps.join(', ')) : '(none)'} | ${inDegree.get(p.name)} |`
    })
    const scriptRows = map.scripts.map((s) => `| ${esc(s.file)} | ${s.main ? 'yes' : 'no'} |`)
    const epRows = map.entryPoints.map((e) => `| ${esc(e.name)} | ${esc(e.target)} | ${esc(e.from)} |`)
    const body = [
        '',
        '## Packages',
        `<!-- sources: ${sources.join(', ')} -->`,
        '<!-- trust: T0 -->',
        '',
        `${map.packages.length} packages (directories with \`__init__.py\` at the repo root, under \`src/\`, or in a \`manage.py\` project folder;`,
        'namespace packages without `__init__.py` are not listed). "depends on" weight = files',
        'importing that package (absolute imports); "imported by" = in-degree. Deterministic',
        'filesystem + import scan — no Python interpreter or package manager is invoked.',
        '',
        '| package | path | depends on | imported by |',
        '|---|---|---|---|',
        ...(pkgRows.length ? pkgRows : ['| (none) | | | |']),
        '',
        '## Scripts',
        '',
        `${map.scripts.length} scripts (\`*.py\` at the repo root, under \`scripts/\` and \`bin/\`). "main" = has an \`if __name__ == "__main__"\` guard.`,
        '',
        '| script | main |',
        '|---|---|',
        ...(scriptRows.length ? scriptRows : ['| (none) | |']),
        '',
        '## Entry points',
        '',
        `${map.entryPoints.length} declared entry points (pyproject \`[project.scripts]\` / \`[project.gui-scripts]\` / \`[tool.poetry.scripts]\`, setup.cfg \`console_scripts\`).`,
        '',
        '| name | target | declared in |',
        '|---|---|---|',
        ...(epRows.length ? epRows : ['| (none) | | |']),
        '',
    ].join('\n')
    return serializeFrontmatter(fields, body) + '\n'
}

/**
 * Parse and render the Python map from a repo. Throws {@link PyMapError} when the repo
 * holds neither packages nor scripts (stack absence — distinguishable, skippable).
 * @param {string} repo repo toplevel
 * @param {{derived: string, harvested: string, version: string}} meta
 * @param {object} [opts] reserved (no overrides yet — layouts are discovered)
 * @returns {{content: string, packageCount: number, scriptCount: number}}
 */
export function buildPyMap(repo, meta, opts = {}) {
    const map = parsePyMap(repo)
    if (map.packages.length === 0 && map.scripts.length === 0)
        throw new PyMapError('no python packages (__init__.py at root or src/) or scripts (*.py at root, scripts/, bin/) found')
    return { content: renderPyMapDoc(map, meta), packageCount: map.packages.length, scriptCount: map.scripts.length }
}
