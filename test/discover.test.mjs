import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import {
    deriveProjectId,
    discover,
    normalizeRemoteUrl,
    repoToplevel,
    storeConfigPath,
} from '../lib/discover.mjs'
import { git, makeGitRepo, makeTmpDir } from './helpers.mjs'

const URL_HTTPS = 'https://git.example.com/acme/demo-repo'

test('normalizeRemoteUrl unifies https/ssh/scp spellings', () => {
    const expected = 'git.example.com/acme/demo-repo'
    assert.equal(normalizeRemoteUrl('https://git.example.com/acme/demo-repo'), expected)
    assert.equal(normalizeRemoteUrl('https://git.example.com/acme/demo-repo.git'), expected)
    assert.equal(normalizeRemoteUrl('git@git.example.com:acme/demo-repo.git'), expected)
    assert.equal(normalizeRemoteUrl('ssh://git@git.example.com/acme/demo-repo.git'), expected)
    assert.equal(normalizeRemoteUrl('HTTPS://USER:PASS@git.example.com/acme/demo-repo/'), expected)
})

test('deriveProjectId is stable and format-correct', () => {
    const repo = makeGitRepo({ remote: URL_HTTPS })
    const id1 = deriveProjectId(repo)
    const id2 = deriveProjectId(repo)
    assert.equal(id1, id2)
    assert.match(id1, /^demo-repo--[0-9a-f]{8}$/)
})

test('same remote in different spellings ⇒ same id (clones share a store)', () => {
    const a = makeGitRepo({ remote: URL_HTTPS })
    const b = makeGitRepo({ remote: 'git@git.example.com:acme/demo-repo.git' })
    assert.equal(deriveProjectId(a), deriveProjectId(b))
})

test('no remote ⇒ id derived from the checkout path basename', () => {
    const repo = makeGitRepo()
    const id = deriveProjectId(repo)
    assert.match(id, /^kaut-test-[a-z0-9-]+--[0-9a-f]{8}$/)
})

test('worktree resolves to the same id as the main checkout', () => {
    const repo = makeGitRepo() // path-derived id exercises --git-common-dir resolution
    const wt = path.join(makeTmpDir(), 'wt')
    git(repo, ['worktree', 'add', '--quiet', wt])
    assert.equal(deriveProjectId(wt), deriveProjectId(repo))
})

test('discovery chain: env wins over pointer, pointer wins over derivation', () => {
    const repo = makeGitRepo({ remote: URL_HTTPS })
    const derived = discover({ cwd: repo, env: {} })
    assert.equal(derived.source, 'derived')
    assert.match(derived.root, /demo-repo--[0-9a-f]{8}$/)
    assert.equal(derived.repo, repo)

    writeFileSync(
        path.join(repo, '.kaut.json'),
        JSON.stringify({ schema: 1, projectId: 'custom-id', root: '/custom/root', engine: '/custom/engine' }),
    )
    const viaPointer = discover({ cwd: repo, env: {} })
    assert.equal(viaPointer.source, 'pointer')
    assert.equal(viaPointer.root, '/custom/root')
    assert.equal(viaPointer.projectId, 'custom-id')
    assert.equal(viaPointer.engine, '/custom/engine')

    const viaEnv = discover({ cwd: repo, env: { KAUT_ROOT: '/env/root' } })
    assert.equal(viaEnv.source, 'env')
    assert.equal(viaEnv.root, '/env/root')
    assert.equal(viaEnv.projectId, 'root')
})

test('malformed pointer falls back to derivation', () => {
    const repo = makeGitRepo({ remote: URL_HTTPS })
    writeFileSync(path.join(repo, '.kaut.json'), '{not json')
    const d = discover({ cwd: repo, env: {} })
    assert.equal(d.source, 'derived')
})

test('storeConfigPath resolves the per-store config file', () => {
    const root = makeTmpDir()
    assert.equal(storeConfigPath(root), path.join(root, 'kaut.config.json'))
})

test('repoToplevel throws EnvironmentError outside a git repo', () => {
    const dir = makeTmpDir()
    assert.throws(() => repoToplevel(dir), /not a git repository/)
})

test('mainBranch falls back to master for fixture repos', () => {
    const repo = makeGitRepo()
    assert.equal(discover({ cwd: repo, env: {} }).mainBranch, 'master')
})
