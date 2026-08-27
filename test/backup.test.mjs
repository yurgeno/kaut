/**
 * `kaut backup` / `kaut restore` — the data home packed into a dated, versioned,
 * RESTORABLE archive with zero external dependencies (hand-rolled ustar + node:zlib).
 * Pins: byte-faithful round trip (deep >100-char paths, exec bits, symlinks, empty
 * dirs), the backups folder never archives itself, restore REFUSES to overwrite
 * existing data without --force, and the archive is readable by the system tar.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeTmpDir } from './helpers.mjs'

const KAUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'kaut.mjs')

function fixtureHome() {
    const home = makeTmpDir()
    // a store-like tree: nested layers, a deep git-object-like path (>100 chars total),
    // an executable, a symlink, telemetry, the registry and setup record
    const store = path.join(home, 'demo-repo--12345678')
    mkdirSync(path.join(store, 'domains'), { recursive: true })
    writeFileSync(path.join(store, 'domains', 'demo.md'), '---\nid: domains/demo\n---\nbody\n')
    const deep = path.join(store, '.git', 'objects', 'aa')
    mkdirSync(deep, { recursive: true })
    writeFileSync(path.join(deep, 'b'.repeat(80)), 'deep object content\n')
    writeFileSync(path.join(store, 'hook.sh'), '#!/bin/sh\necho hi\n', { mode: 0o755 })
    symlinkSync('domains/demo.md', path.join(store, 'link.md'))
    writeFileSync(path.join(store, 'journal.jsonl'), '{"op":"lookup"}\n')
    mkdirSync(path.join(store, 'empty-layer'))
    mkdirSync(path.join(home, 'workspaces'))
    writeFileSync(path.join(home, 'workspaces', 'demo.json'), '{"schema":1}\n')
    writeFileSync(path.join(home, 'setup.json'), '{"schema":1}\n')
    return home
}

function run(args, home) {
    const env = { ...process.env, KAUT_HOME: home }
    return execFileSync('node', [KAUT, ...args], { encoding: 'utf8', env })
}

test('backup: dated versioned archive; restore into a fresh home is byte-faithful', () => {
    const home = fixtureHome()
    const out = run(['backup'], home)
    assert.match(out, /backup written: /)
    const dir = path.join(home, 'backups')
    const archives = readdirSync(dir)
    assert.equal(archives.length, 1)
    assert.match(archives[0], /^kaut-backup-\d{8}-\d{6}-v\d+\.\d+\.\d+\.tar\.gz$/)

    // disaster: a brand-new empty home; restore the archive into it
    const fresh = makeTmpDir()
    run(['restore', path.join(dir, archives[0])], fresh)
    const store = path.join(fresh, 'demo-repo--12345678')
    assert.equal(readFileSync(path.join(store, 'domains', 'demo.md'), 'utf8'), '---\nid: domains/demo\n---\nbody\n')
    assert.equal(readFileSync(path.join(store, '.git', 'objects', 'aa', 'b'.repeat(80)), 'utf8'), 'deep object content\n')
    assert.ok(statSync(path.join(store, 'hook.sh')).mode & 0o100, 'exec bit survives')
    assert.equal(readlinkSync(path.join(store, 'link.md')), 'domains/demo.md')
    assert.equal(readFileSync(path.join(fresh, 'workspaces', 'demo.json'), 'utf8'), '{"schema":1}\n')
    assert.ok(existsSync(path.join(store, 'empty-layer')), 'empty dirs survive')
    assert.ok(!existsSync(path.join(fresh, 'backup-manifest.json')), 'the embedded manifest never lands on disk')
})

test('backup: the backups folder never archives itself', () => {
    const home = fixtureHome()
    run(['backup'], home)
    run(['backup'], home) // second archive must not contain the first
    const dir = path.join(home, 'backups')
    const latest = readdirSync(dir).sort().pop()
    const listing = execFileSync('tar', ['-tzf', path.join(dir, latest)], { encoding: 'utf8' })
    assert.doesNotMatch(listing, /backups\//)
    assert.match(listing, /demo-repo--12345678\/domains\/demo\.md/)
})

test('restore: refuses to overwrite existing data without --force', () => {
    const home = fixtureHome()
    run(['backup'], home)
    const doc = path.join(home, 'demo-repo--12345678', 'domains', 'demo.md')
    writeFileSync(doc, 'NEWER CONTENT — precious\n')
    assert.throws(() => run(['restore', 'latest'], home), /restore refused/)
    assert.equal(readFileSync(doc, 'utf8'), 'NEWER CONTENT — precious\n', 'live data untouched by a refused restore')
    const out = run(['restore', 'latest', '--force'], home)
    assert.match(out, /restored \d+ file/)
    assert.equal(readFileSync(doc, 'utf8'), '---\nid: domains/demo\n---\nbody\n', 'force restores the archived bytes')
})

test('restore with no argument lists the available backups', () => {
    const home = fixtureHome()
    assert.match(run(['restore'], home), /no backups/)
    run(['backup'], home)
    assert.match(run(['restore'], home), /kaut-backup-.*\.tar\.gz/)
})
