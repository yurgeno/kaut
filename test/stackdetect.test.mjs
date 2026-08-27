/**
 * Stack auto-detection + bootstrap wiring: per-stack probes, empty detection, the
 * bootstrap-writes-detected-collectors path, existing-config immutability, `map` running
 * a detected collector end-to-end, and the historical default for configs without
 * map.collectors.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { commitAll, ensureStoreGit } from '../lib/gitstore.mjs'
import { detectCollectors } from '../lib/stackdetect.mjs'
import { commit, makeGitRepo, makeTmpDir, writeRepoFile } from './helpers.mjs'

const KAUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'kaut.mjs')

const JAVA_CONTROLLER = [
    'package demo;',
    '@RestController',
    '@RequestMapping("/api/demo")',
    'public class ItemController {',
    '    @GetMapping("/items")',
    '    public String list() { return "ok"; }',
    '}',
    '',
].join('\n')

/** A nested-gradle spring repo (committed). */
function makeSpringRepo() {
    const repo = makeGitRepo()
    writeRepoFile(repo, 'server/settings.gradle', "include ':app'\n")
    writeRepoFile(repo, 'server/app/build.gradle', 'plugins { id "java" }\n')
    writeRepoFile(repo, 'server/app/src/main/java/demo/ItemController.java', JAVA_CONTROLLER)
    commit(repo, 'spring fixture')
    return repo
}

test('detectCollectors: jvm-gradle + spring (nested build root, bounded controller scan)', () => {
    const det = detectCollectors(makeSpringRepo())
    assert.deepEqual(det.collectors, ['springmap', 'jvmgraph'])
    assert.deepEqual(det.stack, ['jvm-gradle', 'spring'])
})

test('detectCollectors: vue + monorepo; next suppresses a routes-file-only vue hit', () => {
    const vue = makeGitRepo()
    writeRepoFile(vue, 'package.json', JSON.stringify({ dependencies: { vue: '^3.0.0' } }))
    writeRepoFile(vue, 'packages/core/src/index.ts', 'export const c = 1\n')
    commit(vue, 'vue fixture')
    assert.deepEqual(detectCollectors(vue), { collectors: ['routemap', 'pkggraph'], stack: ['vue', 'monorepo'] })

    const next = makeGitRepo()
    writeRepoFile(next, 'package.json', JSON.stringify({ dependencies: { next: '^14.0.0' } }))
    writeRepoFile(next, 'src/router/routes.ts', 'export default []\n') // routes file WITHOUT vue
    writeRepoFile(next, 'app/page.tsx', 'export default function Home() {}\n')
    commit(next, 'next fixture')
    const det = detectCollectors(next)
    assert.deepEqual(det.collectors, ['nextroutes']) // no routemap unless vue is present
    assert.deepEqual(det.stack, ['next'])
})

test('detectCollectors: sql migrations, http backends (js deps + python manifests), php, compose', () => {
    const sql = makeGitRepo()
    writeRepoFile(sql, 'db/migrations/V1__init.sql', 'create table t (id int);\n')
    commit(sql, 'sql fixture')
    assert.deepEqual(detectCollectors(sql), { collectors: ['sqlmigrations'], stack: ['sql-migrations'] })

    const express = makeGitRepo()
    writeRepoFile(express, 'package.json', JSON.stringify({ dependencies: { express: '^4.0.0' } }))
    commit(express, 'express fixture')
    assert.deepEqual(detectCollectors(express), { collectors: ['httproutes'], stack: ['express'] })

    const py = makeGitRepo()
    writeRepoFile(py, 'requirements.txt', 'fastapi==0.110.0\nuvicorn\n')
    commit(py, 'python fixture')
    assert.deepEqual(detectCollectors(py), { collectors: ['httproutes'], stack: ['fastapi'] })

    const php = makeGitRepo()
    writeRepoFile(php, 'composer.json', JSON.stringify({ require: { 'laravel/framework': '^11.0' } }))
    commit(php, 'php fixture')
    assert.deepEqual(detectCollectors(php), { collectors: ['phproutes'], stack: ['php', 'laravel'] })

    const compose = makeGitRepo()
    writeRepoFile(compose, 'docker-compose.yml', 'services:\n  web:\n    image: demo:latest\n')
    commit(compose, 'compose fixture')
    assert.deepEqual(detectCollectors(compose), { collectors: ['composemap'], stack: ['compose'] })
})

test('detectCollectors: an empty repo detects nothing', () => {
    assert.deepEqual(detectCollectors(makeGitRepo()), { collectors: [], stack: [] })
})

test('CLI bootstrap: writes detected collectors into a NEW config, never touches an existing one; map runs the detected collector', () => {
    const repo = makeSpringRepo()
    const root = path.join(makeTmpDir(), 'store')
    const run = (args) =>
        execFileSync('node', [KAUT, ...args], { cwd: repo, encoding: 'utf8', env: { ...process.env, KAUT_ROOT: root } })

    const out = run(['bootstrap'])
    assert.match(out, /map collectors detected: jvm-gradle, spring → springmap, jvmgraph/)
    const cfgPath = path.join(root, 'kaut.config.json')
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'))
    assert.deepEqual(cfg.map.collectors, ['springmap', 'jvmgraph'])

    // the detected collectors drive `map` end-to-end
    const mapOut = run(['map'])
    assert.match(mapOut, /1 routes \(spring\), 1 modules/)
    assert.ok(existsSync(path.join(root, 'map', 'routes.md')))
    assert.ok(existsSync(path.join(root, 'map', 'packages.md')))
    assert.match(
        readFileSync(path.join(root, 'map', 'routes.md'), 'utf8'),
        /\| GET \| \/api\/demo\/items \| ItemController \|/,
    )

    // an existing config is data — a re-bootstrap must not rewrite it
    const sentinel = JSON.stringify({ schema: 1, map: { collectors: ['composemap'] } }, null, 4) + '\n'
    writeFileSync(cfgPath, sentinel)
    const out2 = run(['bootstrap'])
    assert.doesNotMatch(out2, /map collectors detected/)
    assert.equal(readFileSync(cfgPath, 'utf8'), sentinel)
})

test('CLI bootstrap: unknown stack logs the empty-detection note and seeds map.collectors: []', () => {
    const repo = makeGitRepo()
    const root = path.join(makeTmpDir(), 'store')
    const out = execFileSync('node', [KAUT, 'bootstrap'], {
        cwd: repo,
        encoding: 'utf8',
        env: { ...process.env, KAUT_ROOT: root },
    })
    assert.match(out, /map: no known stack detected — map\.collectors: \[\]/)
    const cfg = JSON.parse(readFileSync(path.join(root, 'kaut.config.json'), 'utf8'))
    assert.deepEqual(cfg.map.collectors, [])
})

test('CLI map: a config WITHOUT map.collectors keeps the historical routemap+pkggraph default', () => {
    const repo = makeGitRepo()
    writeRepoFile(repo, 'packages/p1/src/f.ts', "import { z } from '@packages/p2/x'\n")
    writeRepoFile(repo, 'packages/p2/src/g.ts', 'export const g = 1\n')
    commit(repo, 'monorepo without routes file')

    const root = makeTmpDir()
    ensureStoreGit(root)
    writeFileSync(path.join(root, '.gitignore'), '.lock/\n*.tmp\njournal.jsonl\n.DS_Store\n')
    for (const dir of ['map', 'domains', 'decisions']) mkdirSync(path.join(root, dir), { recursive: true })
    // NO map key at all — the pre-collectors config shape
    writeFileSync(path.join(root, 'kaut.config.json'), JSON.stringify({ schema: 1 }) + '\n')
    writeFileSync(path.join(root, 'INDEX.md'), '')
    commitAll(root, 'kaut: test fixture')

    const out = execFileSync('node', [KAUT, 'map'], {
        cwd: repo,
        encoding: 'utf8',
        env: { ...process.env, KAUT_ROOT: root },
    })
    assert.match(out, /routemap skipped/) // default pair ran: routemap absent → skipped
    assert.match(out, /2 packages/) // pkggraph (the second default) still produced its map
    assert.ok(existsSync(path.join(root, 'map', 'packages.md')))
})
