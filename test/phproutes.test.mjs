/**
 * PHP route-map adapter: Laravel Route:: calls (verbs, match, resource), Symfony #[Route]
 * attributes with methods, legacy @Route annotations, vendor/ skip, and absence signaling.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PhpRoutesError, buildPhpRoutes, scanPhpFile } from '../lib/phproutes.mjs'
import { commit, makeGitRepo, writeRepoFile } from './helpers.mjs'

const META = { derived: 'a'.repeat(40), harvested: '2026-08-27', version: '0.3.0' }

const LARAVEL_SRC = [
    '<?php',
    '',
    "use Illuminate\\Support\\Facades\\Route;",
    '',
    "Route::get('/items', [ItemController::class, 'index']);",
    "Route::post('/items', [ItemController::class, 'store']);",
    "Route::match(['get', 'post'], '/form', FormController::class);",
    "Route::resource('/photos', PhotoController::class);",
    '',
].join('\n')

const SYMFONY_SRC = [
    '<?php',
    '',
    'namespace App\\Controller;',
    '',
    'use Symfony\\Component\\Routing\\Attribute\\Route;',
    '',
    'class DemoController',
    '{',
    "    #[Route('/demo', methods: ['GET', 'POST'])]",
    '    public function index() {}',
    '',
    "    #[Route('/demo/simple')]",
    '    public function simple() {}',
    '',
    '    /**',
    '     * @Route("/legacy", methods={"GET"})',
    '     */',
    '    public function legacy() {}',
    '}',
    '',
].join('\n')

test('scanPhpFile: laravel verbs, match expands per method, resource is one row', () => {
    const rows = scanPhpFile(LARAVEL_SRC, 'routes/web.php')
    assert.deepEqual(
        rows.map((r) => [r.method, r.path, r.at]),
        [
            ['GET', '/items', 'routes/web.php:5'],
            ['POST', '/items', 'routes/web.php:6'],
            ['GET', '/form', 'routes/web.php:7'],
            ['POST', '/form', 'routes/web.php:7'],
            ['RESOURCE', '/photos', 'routes/web.php:8'],
        ],
    )
})

test('scanPhpFile: symfony attributes with/without methods, legacy annotation', () => {
    const rows = scanPhpFile(SYMFONY_SRC, 'src/Controller/DemoController.php')
    assert.deepEqual(
        rows.map((r) => [r.method, r.path]),
        [
            ['GET', '/demo'],
            ['POST', '/demo'],
            ['ANY', '/demo/simple'],
            ['GET', '/legacy'],
        ],
    )
})

test('buildPhpRoutes: full repo scan — sorted rows, vendor/ skipped, honest lexical note', () => {
    const repo = makeGitRepo()
    writeRepoFile(repo, 'routes/web.php', LARAVEL_SRC)
    writeRepoFile(repo, 'src/Controller/DemoController.php', SYMFONY_SRC)
    writeRepoFile(repo, 'vendor/pkg/routes.php', "<?php\nRoute::get('/from-vendor', h);\n") // skipped
    commit(repo, 'php fixture')

    const { content, routeCount } = buildPhpRoutes(repo, META)
    assert.equal(routeCount, 9)
    assert.match(content, /id: map\/routes/)
    assert.match(content, /engine: php-routes@0\.3\.0/)
    assert.match(content, /LEXICAL scan, not framework introspection/)
    assert.match(content, /\| RESOURCE \| \/photos \| routes\/web\.php:8 \|/)
    assert.match(content, /\| ANY \| \/demo\/simple \|/)
    assert.doesNotMatch(content, /from-vendor/)
    const rows = content.split('\n').filter((l) => l.startsWith('| ') && !l.startsWith('| method'))
    const paths = rows.map((l) => l.split('|')[2].trim())
    assert.deepEqual(paths, [...paths].sort((a, b) => a.localeCompare(b)))
})

test('buildPhpRoutes: absence — no php files, or php without route registrations', () => {
    assert.throws(() => buildPhpRoutes(makeGitRepo(), META), PhpRoutesError)
    const repo = makeGitRepo()
    writeRepoFile(repo, 'src/Plain.php', '<?php\nclass Plain {}\n')
    commit(repo, 'plain php')
    assert.throws(() => buildPhpRoutes(repo, META), PhpRoutesError)
})
