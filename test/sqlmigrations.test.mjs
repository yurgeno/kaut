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

test('collectMigrations: django per-app numbering and alembic chain order, coexisting with flyway', () => {
    const repo = makeGitRepo()
    writeRepoFile(repo, 'shop/migrations/0001_initial.py', 'from django.db import migrations\n')
    writeRepoFile(repo, 'shop/migrations/0002_add_sku.py', 'from django.db import migrations\n')
    writeRepoFile(repo, 'shop/migrations/__init__.py', '')
    writeRepoFile(repo, 'blog/migrations/0001_initial.py', 'from django.db import migrations\n')
    writeRepoFile(repo, 'alembic/versions/a1b2_init.py', 'revision = "a1b2"\ndown_revision = None\n')
    writeRepoFile(repo, 'alembic/versions/c3d4_users.py', "revision: str = 'c3d4'\ndown_revision: Union[str, None] = 'a1b2'\n")
    writeRepoFile(repo, 'alembic/versions/e5f6_orders.py', 'revision = "e5f6"\ndown_revision = "c3d4"\n')
    writeRepoFile(repo, 'alembic/env.py', 'from alembic import context\n') // not under versions/
    writeRepoFile(repo, 'db/V1__init.sql', 'create table t (id int);\n')
    commit(repo, 'mixed migrations')

    const coll = collectMigrations(repo)
    assert.deepEqual(coll.families, ['flyway', 'django', 'alembic'])
    assert.equal(coll.population, 'flyway+django+alembic')
    const alembic = coll.entries.filter((e) => e.family === 'alembic')
    assert.deepEqual(alembic.map((e) => [e.versionText, e.version[0]]), [['a1b2', 1], ['c3d4', 2], ['e5f6', 3]])
    const django = coll.entries.filter((e) => e.family === 'django')
    assert.deepEqual(django.map((e) => e.versionText), ['blog:0001', 'shop:0001', 'shop:0002'])

    const { content, migrationCount } = buildSqlMigrations(repo, META)
    assert.equal(migrationCount, 7)
    assert.match(content, /7 migrations total: 1 flyway \(Flyway V\*__\*\.sql naming\); 3 django/)
    assert.match(content, /file-glob:\*\*\/migrations\/\?\?\?\?_\*\.py/)
    assert.match(content, /file-glob:\*\*\/versions\/\*\.py/)
    assert.match(content, /### django\n[\s\S]*\| blog:0001 \| initial \| blog\/migrations\/0001_initial\.py \|\n\| shop:0002 \| add_sku \|/) // per app, newest first
    assert.match(content, /### alembic\n[\s\S]*\| e5f6 \| orders \|[\s\S]*\| a1b2 \| init \|/) // head first
})

test('collectMigrations: an alembic set with a broken chain keeps the entries, unordered', () => {
    const repo = makeGitRepo()
    writeRepoFile(repo, 'migrations/versions/x1_one.py', 'revision = "x1"\ndown_revision = "missing"\n')
    writeRepoFile(repo, 'migrations/versions/x2_two.py', 'revision = "x2"\ndown_revision = "x1"\n')
    commit(repo, 'broken chain')
    const coll = collectMigrations(repo)
    assert.deepEqual(coll.families, ['alembic'])
    assert.deepEqual(coll.entries.map((e) => [e.versionText, e.version]), [['x1', null], ['x2', null]])
})
