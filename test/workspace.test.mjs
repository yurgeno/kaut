/**
 * `kaut workspace init|list` (engine v0.3.0): registry generation from a conductor
 * manifest, member-store provisioning with neutral configs, the do-not-touch store policy,
 * system store anchored to the launcher, pointer wiring, idempotent re-runs. Everything
 * runs under an isolated KAUT_HOME so no fixture ever touches the real ~/.kaut.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { commit, git, makeGitRepo, makeTmpDir, writeRepoFile } from './helpers.mjs'
import { systemStoreId } from '../lib/workspace.mjs'

const KAUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'kaut.mjs')

const MINI_COMPOSE = [
    'services:',
    '  api:',
    '    image: registry.example/api:1',
    '    ports:',
    '    - 8080:8080',
    '  worker:',
    '    depends_on:',
    '    - api',
    '    image: registry.example/worker:1',
    'volumes:',
    '  data: null',
    '',
].join('\n')

/** Build a full workspace fixture: conductor + 3 member repos + manifest. */
function makeWorkspaceFixture() {
    const home = makeTmpDir() // isolated KAUT_HOME
    const conductor = makeGitRepo()
    const alpha = makeGitRepo()
    const launcher = makeGitRepo()
    writeRepoFile(launcher, 'docker-compose.yml', MINI_COMPOSE)
    commit(launcher, 'add compose')
    const untouchable = makeGitRepo()
    const manifest = {
        name: 'wtest',
        launcher: { repo: 'launch', compose: 'docker-compose.yml' },
        flow: { tracker: { ticketPattern: 'T-\\d+' } },
        repos: [
            { name: 'alpha', path: alpha },
            { name: 'launch', path: launcher },
            { name: 'frozen', path: untouchable, storePolicy: 'do-not-touch' },
        ],
    }
    const manifestPath = path.join(conductor, 'manifest.json')
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 4))
    return { home, conductor, alpha, launcher, untouchable, manifestPath }
}

/** Run the CLI with an isolated KAUT_HOME (no KAUT_ROOT — pointer/derivation resolve). */
function kaut(cwd, home, args) {
    const env = { ...process.env, KAUT_HOME: home }
    delete env.KAUT_ROOT
    delete env.KAUT_WORKSPACES_DIR
    try {
        return { stdout: execFileSync('node', [KAUT, ...args], { cwd, encoding: 'utf8', env }), code: 0 }
    } catch (e) {
        return { stdout: `${e.stdout ?? ''}${e.stderr ?? ''}`, code: e.status ?? 1 }
    }
}

test('workspace init: registry + member stores + system store + pointers; do-not-touch respected', () => {
    const f = makeWorkspaceFixture()
    const out = kaut(f.conductor, f.home, ['workspace', 'init', '--manifest', f.manifestPath])
    assert.equal(out.code, 0, out.stdout)

    // registry — derived copy with all three members and the launcher-anchored system store
    const reg = JSON.parse(readFileSync(path.join(f.home, 'workspaces', 'wtest.json'), 'utf8'))
    assert.equal(reg.repos.length, 3)
    assert.equal(reg.systemStore.anchorRepo, f.launcher)
    assert.equal(reg.repos.find((r) => r.name === 'frozen').storePolicy, 'do-not-touch')

    // member store: bootstrapped with a NEUTRAL config (no collectors), pointer + local files
    const alphaStore = reg.repos.find((r) => r.name === 'alpha').storeRoot
    assert.ok(alphaStore.startsWith(f.home), 'store must live under the isolated KAUT_HOME')
    const alphaCfg = JSON.parse(readFileSync(path.join(alphaStore, 'kaut.config.json'), 'utf8'))
    assert.deepEqual(alphaCfg.map.collectors, [])
    assert.equal(alphaCfg.tickets.pattern, 'T-\\d+')
    assert.ok(existsSync(path.join(alphaStore, 'INDEX.md')))
    assert.ok(existsSync(path.join(f.alpha, '.kaut.json')))
    assert.ok(existsSync(path.join(f.alpha, 'CLAUDE.local.md')))
    const alphaExclude = readFileSync(path.join(f.alpha, '.git', 'info', 'exclude'), 'utf8')
    assert.match(alphaExclude, /^\.kaut\.json$/m)
    assert.match(alphaExclude, /^CLAUDE\.local\.md$/m)

    // do-not-touch member: registry entry ONLY — no store, no working-tree files
    const frozenStore = reg.repos.find((r) => r.name === 'frozen').storeRoot
    assert.ok(!existsSync(frozenStore))
    assert.ok(!existsSync(path.join(f.untouchable, '.kaut.json')))
    assert.ok(!existsSync(path.join(f.untouchable, 'CLAUDE.local.md')))

    // system store: anchorRepo config + workspace layer dirs + committed
    const sys = reg.systemStore
    assert.equal(sys.id, systemStoreId('wtest'))
    const sysCfg = JSON.parse(readFileSync(path.join(sys.root, 'kaut.config.json'), 'utf8'))
    assert.equal(sysCfg.project.anchorRepo, f.launcher)
    assert.deepEqual(sysCfg.map.collectors, ['composemap'])
    for (const dir of ['map', 'flows', 'runbook', 'decisions', 'contracts'])
        assert.ok(existsSync(path.join(sys.root, dir)), `system store must have ${dir}/`)
    assert.match(git(sys.root, ['log', '--format=%s']), /kaut: workspace init/)

    // conductor pointer → system store; CLAUDE.local.md created
    const pointer = JSON.parse(readFileSync(path.join(f.conductor, '.kaut.json'), 'utf8'))
    assert.equal(pointer.root, sys.root)
    assert.ok(existsSync(path.join(f.conductor, 'CLAUDE.local.md')))

    // map runs against the ANCHOR repo through the pointer (no KAUT_ROOT override)
    const map = kaut(f.conductor, f.home, ['map'])
    assert.equal(map.code, 0, map.stdout)
    assert.match(map.stdout, /map: 2 services/)
    assert.ok(existsSync(path.join(sys.root, 'map', 'services.md')))
    assert.match(kaut(f.conductor, f.home, ['stale']).stdout, /healthy\s+map\/services/)

    // idempotent re-run: exit 0, pointer kept, no duplicate exclude lines
    const again = kaut(f.conductor, f.home, ['workspace', 'init', '--manifest', f.manifestPath])
    assert.equal(again.code, 0, again.stdout)
    assert.match(again.stdout, /pointer\s+exists \(already/)
    const lines = readFileSync(path.join(f.alpha, '.git', 'info', 'exclude'), 'utf8')
        .split('\n')
        .filter((l) => l === 'CLAUDE.local.md')
    assert.equal(lines.length, 1)

    // list sees the workspace
    assert.match(kaut(f.conductor, f.home, ['workspace', 'list']).stdout, /wtest — 3 repos/)
})

test('workspace init: strict validation — unknown launcher and missing repo path are errors', () => {
    const f = makeWorkspaceFixture()
    const bad1 = JSON.parse(readFileSync(f.manifestPath, 'utf8'))
    bad1.launcher.repo = 'nope'
    writeFileSync(f.manifestPath, JSON.stringify(bad1))
    const r1 = kaut(f.conductor, f.home, ['workspace', 'init', '--manifest', f.manifestPath])
    assert.equal(r1.code, 1)
    assert.match(r1.stdout, /launcher\.repo "nope" is not in the repos list/)

    const bad2 = JSON.parse(readFileSync(f.manifestPath, 'utf8'))
    bad2.launcher.repo = 'launch'
    bad2.repos[0].path = path.join(f.alpha, 'does-not-exist')
    writeFileSync(f.manifestPath, JSON.stringify(bad2))
    const r2 = kaut(f.conductor, f.home, ['workspace', 'init', '--manifest', f.manifestPath])
    assert.equal(r2.code, 1)
    assert.match(r2.stdout, /path does not exist/)
})

test('workspace init: dry-run plans without writing', () => {
    const f = makeWorkspaceFixture()
    const out = kaut(f.conductor, f.home, ['workspace', 'init', '--manifest', f.manifestPath, '--dry-run'])
    assert.equal(out.code, 0, out.stdout)
    assert.match(out.stdout, /dry-run/)
    assert.match(out.stdout, /registry-only\s+frozen/)
    assert.ok(!existsSync(path.join(f.home, 'workspaces')))
    assert.ok(!existsSync(path.join(f.conductor, '.kaut.json')))
})
