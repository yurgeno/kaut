/**
 * Next.js route-map adapter: App Router (groups dropped, params kept, route handlers),
 * Pages Router (index folding, api kind, _app/_document/_error exclusion), the src/
 * variants, and stack-absence signaling.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { NextRoutesError, buildNextRoutes, collectNextRoutes } from '../lib/nextroutes.mjs'
import { commit, makeGitRepo, writeRepoFile } from './helpers.mjs'

const META = { derived: 'a'.repeat(40), harvested: '2026-08-27', version: '0.3.0' }

test('buildNextRoutes: App Router — groups dropped, [param]/[...slug] literal, route.ts = kind route', () => {
    const repo = makeGitRepo()
    writeRepoFile(repo, 'app/page.tsx', 'export default function Home() {}\n')
    writeRepoFile(repo, 'app/(marketing)/about/page.tsx', 'export default function About() {}\n')
    writeRepoFile(repo, 'app/blog/[id]/page.tsx', 'export default function Post() {}\n')
    writeRepoFile(repo, 'app/docs/[...slug]/page.tsx', 'export default function Docs() {}\n')
    writeRepoFile(repo, 'app/api/items/route.ts', 'export async function GET() {}\n')
    writeRepoFile(repo, 'app/lib/util.ts', 'export const u = 1\n') // not a route file
    commit(repo, 'app router')

    const { content, routeCount } = buildNextRoutes(repo, META)
    assert.equal(routeCount, 5)
    assert.match(content, /id: map\/routes/)
    assert.match(content, /engine: next-routes@0\.3\.0/)
    assert.match(content, /\| \/ \| page \| app\/page\.tsx \|/)
    assert.match(content, /\| \/about \| page \| app\/\(marketing\)\/about\/page\.tsx \|/) // (group) dropped from the URL
    assert.match(content, /\| \/blog\/\[id\] \| page \|/)
    assert.match(content, /\| \/docs\/\[\.\.\.slug\] \| page \|/)
    assert.match(content, /\| \/api\/items \| route \| app\/api\/items\/route\.ts \|/)
    assert.match(content, /file-glob:app\/\*\*/)
})

test('buildNextRoutes: Pages Router under src/ — index folds, api kind, _app excluded', () => {
    const repo = makeGitRepo()
    writeRepoFile(repo, 'src/pages/index.tsx', 'export default function Home() {}\n')
    writeRepoFile(repo, 'src/pages/about.tsx', 'export default function About() {}\n')
    writeRepoFile(repo, 'src/pages/blog/[id].tsx', 'export default function Post() {}\n')
    writeRepoFile(repo, 'src/pages/api/hello.ts', 'export default function handler() {}\n')
    writeRepoFile(repo, 'src/pages/_app.tsx', 'export default function App() {}\n')
    writeRepoFile(repo, 'src/pages/_document.tsx', 'export default function Doc() {}\n')
    commit(repo, 'pages router')

    const { content, routeCount } = buildNextRoutes(repo, META)
    assert.equal(routeCount, 4)
    assert.match(content, /\| \/ \| page \| src\/pages\/index\.tsx \|/)
    assert.match(content, /\| \/about \| page \|/)
    assert.match(content, /\| \/blog\/\[id\] \| page \|/)
    assert.match(content, /\| \/api\/hello \| api \| src\/pages\/api\/hello\.ts \|/)
    assert.doesNotMatch(content, /_app|_document/)
    assert.match(content, /file-glob:src\/pages\/\*\*/)
})

test('collectNextRoutes: both routers in one repo are merged and sorted', () => {
    const repo = makeGitRepo()
    writeRepoFile(repo, 'app/dash/page.tsx', 'export default function Dash() {}\n')
    writeRepoFile(repo, 'pages/legacy.tsx', 'export default function Legacy() {}\n')
    commit(repo, 'both routers')
    const { rows, bases } = collectNextRoutes(repo)
    assert.deepEqual(bases, ['app', 'pages'])
    assert.deepEqual(rows.map((r) => r.route), ['/dash', '/legacy'])
})

test('buildNextRoutes: absence — no routing dirs, or dirs without route files', () => {
    assert.throws(() => buildNextRoutes(makeGitRepo(), META), NextRoutesError)
    const repo = makeGitRepo()
    writeRepoFile(repo, 'app/lib/util.ts', 'export const u = 1\n') // dir exists, no page/route files
    commit(repo, 'no pages')
    assert.throws(() => buildNextRoutes(repo, META), NextRoutesError)
})
