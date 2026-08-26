/**
 * Test fixtures: temp dirs and disposable git repositories.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

/**
 * @returns {string} a fresh temp directory, realpath-resolved — on macOS /var is a symlink
 * to /private/var and git reports real paths, so fixtures must compare canonically.
 */
export function makeTmpDir() {
    return realpathSync(mkdtempSync(path.join(tmpdir(), 'kaut-test-')))
}

/**
 * @param {string} cwd
 * @param {string[]} args
 * @returns {string}
 */
export function git(cwd, args) {
    return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

/**
 * Create a disposable git repo with one commit.
 * @param {{remote?: string}} [opts] optional origin remote URL
 * @returns {string} repo path
 */
export function makeGitRepo({ remote } = {}) {
    const dir = makeTmpDir()
    git(dir, ['init', '--quiet', '--initial-branch', 'master'])
    git(dir, ['config', 'user.name', 'Test'])
    git(dir, ['config', 'user.email', 'test@local'])
    git(dir, ['config', 'commit.gpgsign', 'false'])
    writeFileSync(path.join(dir, 'README.md'), 'fixture\n')
    git(dir, ['add', '-A'])
    git(dir, ['commit', '--quiet', '-m', 'init'])
    if (remote) git(dir, ['remote', 'add', 'origin', remote])
    return dir
}

/**
 * Write a file into a repo fixture (creating parent dirs); does not commit.
 * @param {string} repo repo path
 * @param {string} rel repo-relative path
 * @param {string} content
 */
export function writeRepoFile(repo, rel, content) {
    const abs = path.join(repo, rel)
    mkdirSync(path.dirname(abs), { recursive: true })
    writeFileSync(abs, content)
}

/**
 * Stage everything and commit; return the new HEAD sha. For building stale-check fixtures.
 * @param {string} repo repo path
 * @param {string} message
 * @returns {string} full HEAD sha
 */
export function commit(repo, message) {
    git(repo, ['add', '-A'])
    git(repo, ['commit', '--quiet', '-m', message])
    return git(repo, ['rev-parse', 'HEAD'])
}

/**
 * Write a valid Phase 0 fact document into a store fixture.
 * @param {string} root store root
 * @param {string} rel store-relative path, e.g. "domains/routing.md"
 * @param {{id?: string, title?: string, sources?: string[], trust?: string, commit?: string, extra?: string}} [over]
 */
export function writeDoc(root, rel, over = {}) {
    const id = over.id ?? rel.replace(/\.md$/, '')
    const sources = over.sources ?? ['file:src/a.ts']
    const lines = [
        '---',
        `id: ${id}`,
        `title: ${over.title ?? 'Test doc'}`,
        'sources:',
        ...sources.map((s) => `    - ${s}`),
        `derived_from_commit: ${over.commit ?? 'a'.repeat(40)}`,
        'harvested: 2026-06-10',
        'engine: manual@0.1.0',
        'tickets: []',
        `trust: ${over.trust ?? 'T1'}`,
        'checks: []',
        'schema_version: 1',
        ...(over.extra ? [over.extra] : []),
        '---',
        '',
        '## Pointers',
        '',
        'content',
        '',
    ]
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
    writeFileSync(path.join(root, rel), lines.join('\n'))
}
