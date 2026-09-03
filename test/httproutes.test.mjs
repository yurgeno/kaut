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

const PY_FAMILIES_SRC = [
    'from litestar import get',
    'from aiohttp import web',
    'from starlette.routing import Route, Mount',
    '',
    '@get("/lit")',
    'async def lit(): ...',
    '',
    '@route("/bottle", method="POST")',
    'def bottle_handler(): ...',
    '',
    '@api.get("/ninja")',
    'def ninja(request): ...',
    '',
    '@bp.route("/single", method="PUT")',
    'def single(): ...',
    '',
    'app.router.add_get("/aio", handler)',
    'app.add_routes([web.post("/aio", handler)])',
    'app.router.add_route("*", "/any", handler)',
    'falcon_app.add_route("/things", ThingsResource())',
    'config.add_route("home", "/pyramid")',
    'routes = [Route("/st", endpoint=home, methods=["GET", "HEAD"]), Mount("/static", app=files)]',
    '    (r"/tornado", MainHandler),',
    'path("not-urls-file/", view)  # decoy: django path() outside urls.py',
    '',
].join('\n')

const DJANGO_URLS_SRC = [
    'from django.urls import include, path, re_path',
    'from rest_framework import routers',
    'router = routers.DefaultRouter()',
    'router.register(r"users", UserViewSet)',
    'urlpatterns = [',
    '    path("", views.index),',
    '    path("articles/<int:year>/", views.year_archive),',
    '    re_path(r"^legacy/(?P<id>\\d+)/$", views.legacy),',
    '    path("api/", include("api.urls")),',
    '    path("api/", include(router.urls)),',
    ']',
    '',
].join('\n')

test('scanHttpFile: python families — litestar/bottle bare decorators, ninja, aiohttp, falcon/pyramid, starlette, tornado; django decoy outside urls.py', () => {
    const rows = scanHttpFile(PY_FAMILIES_SRC, 'svc/app.py').map((r) => [r.method, r.path])
    assert.deepEqual(rows, [
        ['GET', '/lit'],
        ['POST', '/bottle'],
        ['GET', '/ninja'],
        ['PUT', '/single'],
        ['GET', '/aio'],
        ['POST', '/aio'],
        ['ANY', '/any'],
        ['ANY', '/things'],
        ['ANY', '/pyramid'],
        ['GET', '/st'],
        ['HEAD', '/st'],
        ['ANY', '/tornado'],
    ])
})

test('scanHttpFile: django urls.py — path/re_path with ^$ stripped, include → INCLUDE, DRF register → VIEWSET', () => {
    const rows = scanHttpFile(DJANGO_URLS_SRC, 'site/urls.py').map((r) => [r.method, r.path, r.at])
    assert.deepEqual(rows, [
        ['VIEWSET', '/users', 'site/urls.py:4'],
        ['ANY', '/', 'site/urls.py:6'],
        ['ANY', '/articles/<int:year>/', 'site/urls.py:7'],
        ['ANY', '/legacy/(?P<id>\\d+)/', 'site/urls.py:8'],
        ['INCLUDE', '/api/', 'site/urls.py:9'],
        ['INCLUDE', '/api/', 'site/urls.py:10'],
    ])
})
