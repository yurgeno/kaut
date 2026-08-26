/**
 * L0 compose-map adapter (engine v0.3.0, workspace thin slice).
 *
 * Honestly compose-subset-specific: a line-based parser for the regular docker-compose
 * shape — top-level `services:`, 2-space service keys, 4-space scalar/list fields. It is
 * NOT a YAML parser: anchors, extends and inline service maps are out of scope, and the
 * self-check refuses to write when the block's own 2-space key count disagrees with what
 * was parsed (same discipline as the route-map adapter: never silently drop a service the parser failed to
 * understand). Deeper-indented content — environment maps, multiline strings, healthchecks
 * — is ignored by design: the map captures topology (name / image / ports / depends_on /
 * container_name), not configuration.
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { serializeFrontmatter } from './frontmatter.mjs'

/** Thrown when the compose file cannot be parsed into a complete service table. */
export class ComposeMapError extends Error {
    /** @param {string} message */
    constructor(message) {
        super(message)
        this.code = 'KAUT_COMPOSEMAP'
    }
}

/**
 * Parse the `services:` block into a service table. Throws {@link ComposeMapError} when
 * the independent key count disagrees (drift) so the caller writes nothing.
 * @param {string} src docker-compose.yml content
 * @returns {{services: Array<{name: string, image: string, containerName: string,
 *   ports: string[], dependsOn: string[]}>, total: number}}
 */
export function parseCompose(src) {
    const lines = String(src).split('\n')
    let start = -1
    for (let i = 0; i < lines.length; i++) {
        if (/^services:\s*$/.test(lines[i])) {
            start = i + 1
            break
        }
    }
    if (start === -1) throw new ComposeMapError('no top-level "services:" block found')
    let end = lines.length
    for (let i = start; i < lines.length; i++) {
        if (/^[A-Za-z0-9_-]+:/.test(lines[i])) {
            end = i
            break
        }
    }

    const services = []
    let cur = null
    let openList = null // 4-space key that opened a block list (ports/depends_on/networks/…)
    for (let i = start; i < end; i++) {
        const line = lines[i]
        const svc = line.match(/^  ([A-Za-z0-9_.-]+):\s*$/)
        if (svc) {
            cur = { name: svc[1], image: '', containerName: '', ports: [], dependsOn: [] }
            services.push(cur)
            openList = null
            continue
        }
        if (!cur) continue
        const kv = line.match(/^    ([A-Za-z0-9_]+):\s*(.*)$/)
        if (kv) {
            // a bare "key:" opens a list; ANY key is tracked so a following "- item" is
            // attributed correctly (environment can be a list too — it must not leak into
            // a previously open ports/depends_on list)
            openList = kv[2] === '' ? kv[1] : null
            if (kv[1] === 'image') cur.image = kv[2].trim()
            else if (kv[1] === 'container_name') cur.containerName = kv[2].trim()
            continue
        }
        const li = line.match(/^    - (.+)$/)
        if (li && openList) {
            const v = li[1].trim().replace(/^['"]/, '').replace(/['"]$/, '')
            if (openList === 'ports') cur.ports.push(v)
            else if (openList === 'depends_on') cur.dependsOn.push(v)
        }
        // deeper-indented lines (environment maps, multiline strings, healthcheck) — ignored
    }

    // Independent self-check: every 2-space key line in the slice must be a parsed service.
    // Looser regex than the parser's on purpose — an inline service map ("  svc: {…}")
    // counts here but never parses, which surfaces as drift instead of silent loss.
    let independent = 0
    for (let i = start; i < end; i++) if (/^  [^\s-][^:]*:/.test(lines[i])) independent++
    if (services.length === 0) throw new ComposeMapError('no services found under "services:"')
    if (services.length !== independent)
        throw new ComposeMapError(
            `compose self-check failed: parsed ${services.length} services but the block contains ${independent} two-space keys — unrecognized service shape, refusing to write a partial map`,
        )
    return { services, total: services.length }
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
 * Render the `map/services.md` T0 document.
 * @param {ReturnType<typeof parseCompose>['services']} services
 * @param {{derived: string, harvested: string, version: string}} meta
 * @param {string} composeFile repo-relative compose path (the doc's source binding)
 * @returns {string}
 */
export function renderServicesDoc(services, meta, composeFile) {
    const fields = {
        id: 'map/services',
        type: 'map', // OKF type (== layer); stamped for in-place conformance
        title: 'Service map — compose services',
        sources: [`file:${composeFile}`],
        derived_from_commit: meta.derived,
        harvested: meta.harvested,
        engine: `compose-map@${meta.version}`,
        tickets: [],
        trust: 'T0',
        checks: [],
        schema_version: '1',
    }
    const rows = services.map(
        (s) => `| ${esc(s.name)} | ${esc(s.image)} | ${esc(s.ports.join(', '))} | ${esc(s.dependsOn.join(', '))} | ${esc(s.containerName)} |`,
    )
    const body = [
        '',
        '## Services',
        `<!-- sources: file:${composeFile} -->`,
        '<!-- trust: T0 -->',
        '',
        `${services.length} services.`,
        '',
        '| service | image | ports | depends_on | container_name |',
        '|---|---|---|---|---|',
        ...rows,
        '',
    ].join('\n')
    return serializeFrontmatter(fields, body) + '\n'
}

/**
 * Read, parse, and render the service map from a repo. Throws {@link ComposeMapError} on
 * a missing file or drift.
 * @param {string} repo repo toplevel (the store's anchor repo — typically the launcher)
 * @param {{derived: string, harvested: string, version: string}} meta
 * @param {{composeFile?: string}} [opts]
 * @returns {{content: string, serviceCount: number}}
 */
export function buildComposeMap(repo, meta, { composeFile = 'docker-compose.yml' } = {}) {
    const abs = path.join(repo, composeFile)
    if (!existsSync(abs)) throw new ComposeMapError(`compose file not found: ${composeFile}`)
    const { services, total } = parseCompose(readFileSync(abs, 'utf8'))
    return { content: renderServicesDoc(services, meta, composeFile), serviceCount: total }
}
