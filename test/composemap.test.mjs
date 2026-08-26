/**
 * Compose-map adapter (engine v0.3.0): subset parser, drift refusal, doc render, and the
 * CLI map dispatch (config map.collectors + project.anchorRepo working together).
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { commitAll, ensureStoreGit } from '../lib/gitstore.mjs'
import { ComposeMapError, buildComposeMap, parseCompose } from '../lib/composemap.mjs'
import { commit, git, makeGitRepo, makeTmpDir, writeRepoFile } from './helpers.mjs'

const KAUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'kaut.mjs')

/** A miniature of the real launcher compose: every quirk the parser must survive. */
const FIXTURE = [
    'networks:',
    '  app-net:',
    '    name: app-net',
    'services:',
    '  alpha:',
    '    container_name: alpha',
    '    environment:',
    '      JAVA_TOOL_OPTIONS: -Xmx1g',
    "      SPRING_APPLICATION_JSON: '{ \"spring.config.import\": \"configserver:http://cs\",",
    '        "spring.profiles.active": "local", "spring.cloud.config.label": "master" }',
    '',
    "        '",
    '      TZ: Europe/Prague',
    '    image: registry.example/org/alpha:master',
    '    networks:',
    '    - app-net',
    '    ports:',
    '    - 8081:8081',
    '    - 5005:5005',
    '  beta:',
    '    environment:',
    '    - TZ=Europe/Prague',
    '    image: registry.example/org/beta:latest',
    '    ports:',
    "    - '25:25'",
    '  gamma:',
    '    depends_on:',
    '    - alpha',
    '    - beta',
    '    healthcheck:',
    '      interval: 30s',
    '      test: curl -s http://localhost | grep ok',
    '    image: registry.example/org/gamma:1.0',
    'volumes:',
    '  data: null',
    '',
].join('\n')

test('parseCompose: scopes to services:, survives multiline env strings and env lists', () => {
    const { services, total } = parseCompose(FIXTURE)
    assert.equal(total, 3) // networks/volumes children NOT counted (the real-world "29 vs 25" trap)
    const [alpha, beta, gamma] = services
    assert.equal(alpha.name, 'alpha')
    assert.equal(alpha.image, 'registry.example/org/alpha:master')
    assert.equal(alpha.containerName, 'alpha')
    assert.deepEqual(alpha.ports, ['8081:8081', '5005:5005'])
    assert.deepEqual(beta.ports, ['25:25']) // quoted port unquoted; env list item NOT leaked into ports
    assert.deepEqual(gamma.dependsOn, ['alpha', 'beta'])
})

test('parseCompose: refuses an inline service map (drift, not silent loss)', () => {
    const bad = ['services:', '  ok:', '    image: x', '  weird: { image: y }', ''].join('\n')
    assert.throws(() => parseCompose(bad), ComposeMapError)
})

test('parseCompose: refuses when services: is missing or empty', () => {
    assert.throws(() => parseCompose('volumes:\n  v: null\n'), ComposeMapError)
    assert.throws(() => parseCompose('services:\nvolumes:\n  v: null\n'), ComposeMapError)
})

test('buildComposeMap: renders a valid T0 doc; missing file throws', () => {
    const repo = makeGitRepo()
    writeRepoFile(repo, 'docker-compose.yml', FIXTURE)
    commit(repo, 'add compose')
    const meta = { derived: 'a'.repeat(40), harvested: '2026-06-12', version: '0.3.0' }
    const { content, serviceCount } = buildComposeMap(repo, meta)
    assert.equal(serviceCount, 3)
    assert.match(content, /id: map\/services/)
    assert.match(content, /engine: compose-map@0\.3\.0/)
    assert.match(content, /\| alpha \| registry\.example\/org\/alpha:master \| 8081:8081, 5005:5005 \|  \| alpha \|/)
    assert.throws(() => buildComposeMap(makeGitRepo(), meta), ComposeMapError)
})

test('CLI map: collectors=[composemap] + anchorRepo generate map/services.md from the anchor repo', () => {
    // launcher repo holds the compose file; the conductor repo is where the command runs
    const launcher = makeGitRepo()
    writeRepoFile(launcher, 'docker-compose.yml', FIXTURE)
    commit(launcher, 'add compose')
    const conductor = makeGitRepo()

    const root = makeTmpDir()
    ensureStoreGit(root)
    writeFileSync(path.join(root, '.gitignore'), '.lock/\n*.tmp\njournal.jsonl\n.DS_Store\n')
    for (const dir of ['map', 'domains', 'decisions']) mkdirSync(path.join(root, dir), { recursive: true })
    writeFileSync(
        path.join(root, 'kaut.config.json'),
        JSON.stringify(
            {
                schema: 1,
                project: { id: 'system-test', repo: conductor, mainBranch: 'master', anchorRepo: launcher },
                map: { collectors: ['composemap'] },
            },
            null,
            4,
        ),
    )
    writeFileSync(path.join(root, 'INDEX.md'), '')
    commitAll(root, 'kaut: test fixture')

    const run = (args) =>
        execFileSync('node', [KAUT, ...args], {
            cwd: conductor,
            encoding: 'utf8',
            env: { ...process.env, KAUT_ROOT: root },
        })

    const out = run(['map'])
    assert.match(out, /map: 3 services/)
    assert.match(out, /committed/)
    assert.ok(existsSync(path.join(root, 'map', 'services.md')))
    const doc = readFileSync(path.join(root, 'map', 'services.md'), 'utf8')
    const anchorSha = git(launcher, ['rev-parse', 'HEAD'])
    assert.match(doc, new RegExp(`derived_from_commit: ${anchorSha}`)) // derived from the ANCHOR repo
    assert.match(readFileSync(path.join(root, 'INDEX.md'), 'utf8'), /map\/services/)
    const journal = readFileSync(path.join(root, 'journal.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    assert.equal(journal.at(-1).topic, 'map/services')

    // freshness end-to-end: healthy now; stale after the compose changes on the anchor repo
    assert.match(run(['stale']), /healthy\s+map\/services/)
    writeRepoFile(launcher, 'docker-compose.yml', FIXTURE + '\n# touched\n')
    commit(launcher, 'touch compose')
    assert.match(run(['stale']), /stale\s+map\/services/)
})
