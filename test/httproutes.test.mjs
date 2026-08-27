/**
 * Generic HTTP route-map adapter: Express-style calls, Nest decorators, FastAPI/Flask
 * decorators, decoy rejection, skip list, file:line stamping, and stack-absence signaling.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { HttpRoutesError, buildHttpRoutes, scanHttpFile } from '../lib/httproutes.mjs'
import { commit, makeGitRepo, writeRepoFile } from './helpers.mjs'

const META = { derived: 'a'.repeat(40), harvested: '2026-08-27', version: '0.3.0' }

const EXPRESS_SRC = [
    "const express = require('express')",
    'const app = express()',
    "app.get('/health', (req, res) => res.send('ok'))",
    "app.post('/items', createItem)",
    "router.use('/api', apiRouter)",
    "cache.get('key') // decoy: not a route (no leading slash)",
    '',
].join('\n')

const NEST_SRC = [
    "import { Controller, Get, Post } from '@nestjs/common'",
    '',
    "@Controller('items')",
    'export class ItemsController {',
    '    @Get()',
    '    findAll() {}',
    '',
    "    @Post('create')",
    '    create() {}',
    '}',
    '',
].join('\n')

const PY_SRC = [
    'from fastapi import FastAPI',
    'app = FastAPI()',
    '',
    '@app.get("/items")',
    'def list_items():',
    '    return []',
    '',
    '@app.route("/legacy", methods=["GET", "POST"])',
    'def legacy():',
    '    return "ok"',
    '',
].join('\n')

test('scanHttpFile: express calls with file:line; the no-slash decoy is rejected', () => {
    const rows = scanHttpFile(EXPRESS_SRC, 'server/index.js')
    assert.deepEqual(rows, [
        { method: 'GET', path: '/health', at: 'server/index.js:3' },
        { method: 'POST', path: '/items', at: 'server/index.js:4' },
        { method: 'USE', path: '/api', at: 'server/index.js:5' },
    ])
})

test('scanHttpFile: nest decorators — bare @Get() maps to /, relative paths get a slash', () => {
    const rows = scanHttpFile(NEST_SRC, 'src/items.controller.ts')
    assert.deepEqual(
        rows.map((r) => [r.method, r.path]),
        [['GET', '/'], ['POST', '/create']],
    )
})

test('scanHttpFile: python — fastapi decorator + flask route with a methods list', () => {
    const rows = scanHttpFile(PY_SRC, 'api/main.py')
    assert.deepEqual(
        rows.map((r) => [r.method, r.path, r.at]),
        [
            ['GET', '/items', 'api/main.py:4'],
            ['GET', '/legacy', 'api/main.py:8'],
            ['POST', '/legacy', 'api/main.py:8'],
        ],
    )
})

test('buildHttpRoutes: mixed repo scans both families, sorts rows, skips node_modules', () => {
    const repo = makeGitRepo()
    writeRepoFile(repo, 'server/index.js', EXPRESS_SRC)
    writeRepoFile(repo, 'api/main.py', PY_SRC)
    writeRepoFile(repo, 'node_modules/pkg/index.js', "app.get('/from-deps', h)\n") // skipped
    commit(repo, 'backend fixture')

    const { content, routeCount } = buildHttpRoutes(repo, META)
    assert.equal(routeCount, 6)
    assert.match(content, /id: map\/routes/)
    assert.match(content, /engine: http-routes@0\.3\.0/)
    assert.match(content, /LEXICAL scan, not framework introspection/)
    assert.match(content, /\| GET \| \/health \| server\/index\.js:3 \|/)
    assert.match(content, /\| POST \| \/legacy \| api\/main\.py:8 \|/)
    assert.doesNotMatch(content, /from-deps/)
})

test('buildHttpRoutes: a repo without route registrations throws the absence error', () => {
    const repo = makeGitRepo()
    writeRepoFile(repo, 'src/util.js', 'export const u = 1\n')
    commit(repo, 'no routes')
    assert.throws(() => buildHttpRoutes(repo, META), HttpRoutesError)
})
