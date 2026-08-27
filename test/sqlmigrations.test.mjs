/**
 * SQL-migrations map adapter: Flyway version parsing/ordering, the 15-entry cap, the
 * migration-directory fallback population, and stack-absence signaling.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SqlMigrationsError, buildSqlMigrations, collectMigrations } from '../lib/sqlmigrations.mjs'
import { commit, makeGitRepo, writeRepoFile } from './helpers.mjs'

const META = { derived: 'a'.repeat(40), harvested: '2026-08-27', version: '0.3.0' }

test('buildSqlMigrations: numeric version ordering (10 > 3 > 2.1 > 1) and top-level dirs', () => {
    const repo = makeGitRepo()
    writeRepoFile(repo, 'db/migrations/V1__init.sql', 'create table demo (id int);\n')
    writeRepoFile(repo, 'db/migrations/V2_1__add_column.sql', 'alter table demo add name text;\n')
    writeRepoFile(repo, 'db/migrations/V10__cleanup.sql', 'drop table legacy;\n')
    writeRepoFile(repo, 'other/V3__seed.sql', 'insert into demo values (1);\n')
    writeRepoFile(repo, 'docs/notes.sql', '-- not a migration\n') // no V-prefix, no migration dir
    commit(repo, 'migrations')

    const { content, migrationCount } = buildSqlMigrations(repo, META)
    assert.equal(migrationCount, 4)
    assert.match(content, /id: map\/migrations/)
    assert.match(content, /engine: sql-migrations@0\.3\.0/)
    assert.match(content, /Top-level directories holding migrations: `db`, `other`/)
    const rows = content.split('\n').filter((l) => l.startsWith('| ') && !l.startsWith('| version'))
    const versions = rows.map((l) => l.split('|')[1].trim())
    assert.deepEqual(versions, ['10', '3', '2.1', '1']) // numeric, not lexicographic; V2_1 → 2.1
    assert.match(rows[0], /\| cleanup \| db\/migrations\/V10__cleanup\.sql \|/)
})

test('buildSqlMigrations: table caps at the 15 highest versions, count stays total', () => {
    const repo = makeGitRepo()
    for (let i = 1; i <= 20; i++) writeRepoFile(repo, `db/V${i}__step_${i}.sql`, `-- step ${i}\n`)
    commit(repo, 'many migrations')
    const { content, migrationCount } = buildSqlMigrations(repo, META)
    assert.equal(migrationCount, 20)
    const rows = content.split('\n').filter((l) => l.startsWith('| ') && !l.startsWith('| version'))
    assert.equal(rows.length, 15)
    assert.match(rows[0], /\| 20 \|/) // highest first
    assert.match(rows[14], /\| 6 \|/) // 20..6 = 15 entries
})

test('collectMigrations: fallback population — *.sql under migration* dirs, no versions', () => {
    const repo = makeGitRepo()
    writeRepoFile(repo, 'db/migration/001_init.sql', 'create table demo (id int);\n')
    writeRepoFile(repo, 'db/other/keep.sql', '-- not under a migration dir\n')
    commit(repo, 'fallback layout')
    const coll = collectMigrations(repo)
    assert.equal(coll.population, 'fallback')
    assert.deepEqual(coll.entries.map((e) => e.file), ['db/migration/001_init.sql'])
    const { content, migrationCount } = buildSqlMigrations(repo, META)
    assert.equal(migrationCount, 1)
    assert.match(content, /\| — \| 001_init \| db\/migration\/001_init\.sql \|/)
    assert.match(content, /no parseable versions/)
})

test('buildSqlMigrations: a repo without migrations throws the absence error', () => {
    assert.throws(() => buildSqlMigrations(makeGitRepo(), META), SqlMigrationsError)
})
