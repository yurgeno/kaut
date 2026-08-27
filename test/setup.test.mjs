/**
 * `kaut setup` — the guided install. Non-interactive path (flags): the data-home
 * redirect is written, sibling repos are scanned and selected, bootstrap runs
 * idempotently (existing store data is ACTUALIZED, never wiped), the selection is
 * recorded in the data home, and the next-steps guidance names the MCP server and the
 * agent-integration doc.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { git, makeTmpDir } from './helpers.mjs'

const KAUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'kaut.mjs')

function run(args, env) {
    return execFileSync('node', [KAUT, ...args], { encoding: 'utf8', env })
}

/** Two sibling git repos + an isolated $HOME; setup scans via --scan. */
function fixture() {
    const scanDir = makeTmpDir()
    for (const name of ['repo-one', 'repo-two']) {
        const dir = path.join(scanDir, name)
        mkdirSync(dir)
        git(dir, ['init', '--quiet', '--initial-branch', 'master'])
        git(dir, ['config', 'user.name', 'Test'])
        git(dir, ['config', 'user.email', 'test@local'])
        writeFileSync(path.join(dir, 'README.md'), `${name}\n`)
        git(dir, ['add', '-A'])
        git(dir, ['commit', '--quiet', '-m', 'init'])
    }
    const fakeHome = makeTmpDir()
    const env = { ...process.env, HOME: fakeHome }
    delete env.KAUT_HOME
    delete env.KAUT_ROOT
    return { scanDir, env }
}

test('setup: data redirect + selected repo bootstrapped + guidance printed', () => {
    const { scanDir, env } = fixture()
    const dataDir = path.join(scanDir, 'kaut-data')
    const out = run(['setup', '--scan', scanDir, '--data', dataDir, '--repos', 'repo-one', '--bootstrap', '--yes'], env)
    // redirect persisted in the isolated anchor
    const cfg = JSON.parse(readFileSync(path.join(env.HOME, '.kaut', 'config.json'), 'utf8'))
    assert.equal(cfg.dataRoot, dataDir)
    // exactly the selected repo got a store, under the data home
    const stores = readdirSync(dataDir).filter((n) => n.includes('--'))
    assert.equal(stores.length, 1)
    assert.match(stores[0], /^repo-one--/)
    // selection recorded; guidance names the wiring steps
    const rec = JSON.parse(readFileSync(path.join(dataDir, 'setup.json'), 'utf8'))
    assert.deepEqual(rec.repos.map((r) => r.name), ['repo-one'])
    assert.equal(rec.bootstrapped, true)
    assert.match(out, /mcp\.mjs/)
    assert.match(out, /AGENT-INTEGRATION\.md/)
})

test('setup: re-run ACTUALIZES — existing store data is never wiped', () => {
    const { scanDir, env } = fixture()
    const dataDir = path.join(scanDir, 'kaut-data')
    run(['setup', '--scan', scanDir, '--data', dataDir, '--repos', 'all', '--bootstrap', '--yes'], env)
    const store = path.join(dataDir, readdirSync(dataDir).find((n) => n.startsWith('repo-one--')))
    // plant live data: a doc landed through the pipeline between runs
    const marker = path.join(store, 'domains', 'precious.md')
    writeFileSync(marker, 'irreplaceable\n')
    const out2 = run(['setup', '--scan', scanDir, '--data', dataDir, '--repos', 'all', '--bootstrap', '--yes'], env)
    assert.ok(existsSync(marker), 'existing store content survives a setup re-run')
    assert.equal(readFileSync(marker, 'utf8'), 'irreplaceable\n')
    assert.match(out2, /actualized/, 're-run reports actualization, not re-creation')
})

test('setup: --no-bootstrap configures only and prints the per-repo commands', () => {
    const { scanDir, env } = fixture()
    const dataDir = path.join(scanDir, 'kaut-data')
    const out = run(['setup', '--scan', scanDir, '--data', dataDir, '--repos', 'all', '--no-bootstrap', '--yes'], env)
    assert.equal(readdirSync(dataDir).filter((n) => n.includes('--')).length, 0, 'no stores created')
    const rec = JSON.parse(readFileSync(path.join(dataDir, 'setup.json'), 'utf8'))
    assert.equal(rec.bootstrapped, false)
    assert.match(out, /bootstrap skipped/)
    assert.match(out, /kaut\.mjs bootstrap/)
})

test('setup: unknown repo selection is refused with a clear error', () => {
    const { scanDir, env } = fixture()
    assert.throws(
        () => run(['setup', '--scan', scanDir, '--data', path.join(scanDir, 'kaut-data'), '--repos', 'nope', '--bootstrap', '--yes'], env),
        /unknown repository selection "nope"/,
    )
})

test('setup with env KAUT_HOME: the global redirect is NOT rewritten (env-isolated runs stay isolated)', () => {
    const { scanDir, env } = fixture()
    const kautHome = makeTmpDir()
    const dataDir = path.join(scanDir, 'kaut-data')
    const out = run(
        ['setup', '--scan', scanDir, '--data', dataDir, '--repos', 'repo-one', '--bootstrap', '--yes'],
        { ...env, KAUT_HOME: kautHome },
    )
    // no redirect written into the anchor — env outranks it for every resolution anyway
    assert.equal(existsSync(path.join(env.HOME, '.kaut', 'config.json')), false)
    // the store landed where the process actually resolves the home: KAUT_HOME
    assert.equal(readdirSync(kautHome).filter((n) => n.startsWith('repo-one--')).length, 1)
    assert.match(out, /NOT persisted/)
})

test('home <dir> with env KAUT_HOME: refuses to persist and says why', () => {
    const { env } = fixture()
    const kautHome = makeTmpDir()
    const out = run(['home', makeTmpDir()], { ...env, KAUT_HOME: kautHome })
    assert.equal(existsSync(path.join(env.HOME, '.kaut', 'config.json')), false)
    assert.match(out, /KAUT_HOME is set/)
})
