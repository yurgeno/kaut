/**
 * Engine-vs-data hardening (v0.3.0): adapter file locations come from config with stack
 * defaults as fallback — no project-specific paths baked into behavior.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { commit, makeGitRepo, writeRepoFile } from './helpers.mjs'
import { buildRouteMap, RouteMapError } from '../lib/routemap.mjs'
import { buildPackageGraph } from '../lib/pkggraph.mjs'

const ROUTES_SRC = [
    "import { HomeView } from '@packages/core/views'",
    'export default [',
    '    {',
    "        path: '/home',",
    '        component: HomeView,',
    '    },',
    ']',
    '',
].join('\n')
const CONSTANTS_SRC = 'const ROUTER_PATH = {\n}\n'

test('routemap: custom routesFile/constantsFile via opts; stack default still applies when omitted', () => {
    const repo = makeGitRepo()
    writeRepoFile(repo, 'app/routes.ts', ROUTES_SRC)
    writeRepoFile(repo, 'app/consts.ts', CONSTANTS_SRC)
    commit(repo, 'custom layout')
    const meta = { derived: 'a'.repeat(40), harvested: '2026-06-12', version: '0.3.0' }

    const { content, routeCount } = buildRouteMap(repo, meta, {
        routesFile: 'app/routes.ts',
        constantsFile: 'app/consts.ts',
    })
    assert.equal(routeCount, 1)
    assert.match(content, /file:app\/routes\.ts/) // doc sources follow the configured paths
    assert.match(content, /file:app\/consts\.ts/)

    // omitted opts → stack default path, which this repo does not have
    assert.throws(() => buildRouteMap(repo, meta), RouteMapError)
})

test('pkggraph: custom packagesDir via opts; sources binding follows it', () => {
    const repo = makeGitRepo()
    writeRepoFile(repo, 'libs/p1/src/f.ts', "import { z } from '@packages/p2/x'\n")
    writeRepoFile(repo, 'libs/p2/src/g.ts', 'export const g = 1\n')
    commit(repo, 'libs layout')
    const meta = { derived: 'a'.repeat(40), harvested: '2026-06-12', version: '0.3.0' }

    const { content, packageCount } = buildPackageGraph(repo, meta, { packagesDir: 'libs' })
    assert.equal(packageCount, 2)
    assert.match(content, /file-glob:libs\/\*\/src\/\*\*/)
    assert.match(content, /\| p1 \| p2\(1\) \| 0 \|/)

    // default dir → no packages in this repo
    assert.equal(buildPackageGraph(repo, meta).packageCount, 0)
})
