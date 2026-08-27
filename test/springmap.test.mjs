/**
 * Spring route-map adapter: annotation parse (Java + Kotlin), class-base joining,
 * constant-path best-effort rendering, skip list, and stack-absence signaling.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SpringMapError, buildSpringMap, parseSpringFile } from '../lib/springmap.mjs'
import { commit, makeGitRepo, writeRepoFile } from './helpers.mjs'

const META = { derived: 'a'.repeat(40), harvested: '2026-08-27', version: '0.3.0' }

const JAVA_CONTROLLER = [
    'package demo;',
    '',
    'import org.springframework.web.bind.annotation.*;',
    '',
    '@RestController',
    '@RequestMapping("/api/demo")',
    'public class ItemController {',
    '    @GetMapping("/items")',
    '    public String list() { return "ok"; }',
    '',
    '    @PostMapping(value = "/items")',
    '    public String create() { return "ok"; }',
    '',
    '    @RequestMapping(method = RequestMethod.DELETE, value = "/items/{id}")',
    '    public void remove() {}',
    '}',
    '',
].join('\n')

const KOTLIN_CONTROLLER = [
    'package demo',
    '',
    '@RestController',
    'class StatusController {',
    '    @GetMapping',
    '    fun status(): String = "ok"',
    '}',
    '',
].join('\n')

const CONST_CONTROLLER = [
    'package demo;',
    '',
    '@RestController',
    'public class ConstController {',
    '    @GetMapping(ApiPaths.ITEMS)',
    '    public String byConst() { return "ok"; }',
    '}',
    '',
].join('\n')

test('parseSpringFile: class base + method paths join into normalized routes', () => {
    const rows = parseSpringFile(JAVA_CONTROLLER, 'src/main/java/demo/ItemController.java')
    assert.equal(rows.length, 3)
    assert.deepEqual(
        rows.map((r) => [r.method, r.path, r.controller]),
        [
            ['GET', '/api/demo/items', 'ItemController'],
            ['POST', '/api/demo/items', 'ItemController'],
            ['DELETE', '/api/demo/items/{id}', 'ItemController'],
        ],
    )
})

test('parseSpringFile: bare @GetMapping without a class base maps to /; non-controller file is null', () => {
    const rows = parseSpringFile(KOTLIN_CONTROLLER, 'src/main/kotlin/demo/StatusController.kt')
    assert.deepEqual(rows, [{ method: 'GET', path: '/', controller: 'StatusController', file: 'src/main/kotlin/demo/StatusController.kt' }])
    assert.equal(parseSpringFile('package demo\nclass Plain {}\n', 'Plain.kt'), null)
})

test('buildSpringMap: nested gradle root, Kotlin covered, constant paths render as expression text', () => {
    const repo = makeGitRepo()
    // the gradle project root is nested one level down — the recursive scan must cover it
    writeRepoFile(repo, 'server/src/main/java/demo/ItemController.java', JAVA_CONTROLLER)
    writeRepoFile(repo, 'server/src/main/kotlin/demo/StatusController.kt', KOTLIN_CONTROLLER)
    writeRepoFile(repo, 'server/src/main/java/demo/ConstController.java', CONST_CONTROLLER)
    // decoy in a skip dir: must NOT be scanned
    writeRepoFile(repo, 'server/build/generated/Gen.java', '@RestController\nclass Gen {\n@GetMapping("/gen")\nvoid g() {}\n}\n')
    commit(repo, 'add controllers')

    const { content, routeCount } = buildSpringMap(repo, META)
    assert.equal(routeCount, 5) // 3 java + 1 kotlin + 1 const
    assert.match(content, /id: map\/routes/)
    assert.match(content, /engine: spring-map@0\.3\.0/)
    assert.match(content, /\| GET \| \/api\/demo\/items \| ItemController \| server\/src\/main\/java\/demo\/ItemController\.java \|/)
    assert.match(content, /\| GET \| \/ \| StatusController \|/)
    assert.match(content, /ApiPaths\.ITEMS/) // constant path rendered as the expression text
    assert.doesNotMatch(content, /\/gen/) // build/ decoy skipped
    // rows sorted by path (locale order, matching the collector)
    const rows = content.split('\n').filter((l) => l.startsWith('| ') && !l.startsWith('| method'))
    const paths = rows.map((l) => l.split('|')[2].trim())
    assert.deepEqual(paths, [...paths].sort((a, b) => a.localeCompare(b)))
})

test('buildSpringMap: a repo without controllers throws the absence error', () => {
    const repo = makeGitRepo()
    writeRepoFile(repo, 'src/main/java/demo/Plain.java', 'package demo;\npublic class Plain {}\n')
    commit(repo, 'no controllers')
    assert.throws(() => buildSpringMap(repo, META), SpringMapError)
})
