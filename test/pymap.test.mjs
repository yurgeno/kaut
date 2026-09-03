/**
 * Python package/script map adapter: src- and flat-layout packages, import edges with
 * weights, scripts with the __main__ flag, entry points from pyproject/setup.cfg, Django
 * app marking, and stack-absence signaling.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PyMapError, buildPyMap, importedTopLevel, parsePyprojectScripts, parseSetupCfgScripts } from '../lib/pymap.mjs'
import { commit, makeGitRepo, writeRepoFile } from './helpers.mjs'

const META = { derived: 'a'.repeat(40), harvested: '2026-09-03', version: '0.9.0' }

test('importedTopLevel: absolute imports only, first segment, comma lists', () => {
    const src = 'import os, sys\nimport core.db as db\nfrom core.models import User\nfrom . import x\nfrom .sibling import y\n  from api import v1\n'
    assert.deepEqual([...importedTopLevel(src)].sort(), ['api', 'core', 'os', 'sys'])
})

test('parsePyprojectScripts / parseSetupCfgScripts: entry-point tables', () => {
    const toml = '[project]\nname = "demo"\n\n[project.scripts]\ndemo-cli = "demo.cli:main"\n\n[tool.poetry.scripts]\nlegacy = "demo.old:run"\n\n[tool.ruff]\nline-length = 100\n'
    assert.deepEqual(parsePyprojectScripts(toml), [
        { name: 'demo-cli', target: 'demo.cli:main' },
        { name: 'legacy', target: 'demo.old:run' },
    ])
    const cfg = '[options.entry_points]\nconsole_scripts =\n    demo = demo.cli:main\n    other = demo.x:y\n\n[flake8]\nmax-line-length = 100\n'
    assert.deepEqual(parseSetupCfgScripts(cfg), [
        { name: 'demo', target: 'demo.cli:main' },
        { name: 'other', target: 'demo.x:y' },
    ])
})

test('buildPyMap: src layout + toplevel packages, weighted edges, scripts, entry points, django app', () => {
    const repo = makeGitRepo()
    writeRepoFile(repo, 'pyproject.toml', '[project]\nname = "demo"\n[project.scripts]\ndemo = "demo.cli:main"\n')
    writeRepoFile(repo, 'src/demo/__init__.py', '')
    writeRepoFile(repo, 'src/demo/cli.py', 'import core\nfrom core.db import connect\n\ndef main():\n    pass\n')
    writeRepoFile(repo, 'src/demo/api.py', 'from core import models\n')
    writeRepoFile(repo, 'core/__init__.py', '')
    writeRepoFile(repo, 'core/models.py', 'class User: ...\n')
    writeRepoFile(repo, 'core/db.py', 'import os\n')
    writeRepoFile(repo, 'shop/__init__.py', '')
    writeRepoFile(repo, 'shop/models.py', 'from core.models import User\n')
    writeRepoFile(repo, 'shop/apps.py', 'class ShopConfig: ...\n')
    writeRepoFile(repo, 'tests/test_x.py', 'import demo\n') // no __init__.py → not a package
    writeRepoFile(repo, 'manage.py', 'if __name__ == "__main__":\n    pass\n')
    writeRepoFile(repo, 'scripts/backfill.py', 'import core\n')
    writeRepoFile(repo, '.venv/lib/site-packages/x/__init__.py', '') // skipped
    commit(repo, 'python fixture')

    const { content, packageCount, scriptCount } = buildPyMap(repo, META)
    assert.equal(packageCount, 3)
    assert.equal(scriptCount, 2)
    assert.match(content, /id: map\/packages/)
    assert.match(content, /engine: py-map@0\.9\.0/)
    assert.match(content, /file-glob:\*\*\/\*\.py/)
    assert.match(content, /file:pyproject\.toml/)
    assert.match(content, /\| core \| core \| \(none\) \| 2 \|/)
    assert.match(content, /\| demo \| src\/demo \| core\(2\) \| 0 \|/) // two files in demo import core
    assert.match(content, /\| shop \(django app\) \| shop \| core\(1\) \| 0 \|/)
    assert.match(content, /\| manage\.py \| yes \|/)
    assert.match(content, /\| scripts\/backfill\.py \| no \|/)
    assert.match(content, /\| demo \| demo\.cli:main \| pyproject\.toml \|/)
    assert.doesNotMatch(content, /site-packages/)
    assert.doesNotMatch(content, /\| tests /)
})

test('buildPyMap: a django project kept one level down (backend/manage.py) is a package root', () => {
    const repo = makeGitRepo()
    writeRepoFile(repo, 'requirements.txt', 'Django\n')
    writeRepoFile(repo, 'backend/manage.py', 'if __name__ == "__main__":\n    pass\n')
    writeRepoFile(repo, 'backend/shop/__init__.py', '')
    writeRepoFile(repo, 'backend/shop/apps.py', 'class ShopConfig: ...\n')
    writeRepoFile(repo, 'backend/shop/views.py', 'from core.util import x\n')
    writeRepoFile(repo, 'backend/core/__init__.py', '')
    writeRepoFile(repo, 'backend/core/util.py', 'x = 1\n')
    commit(repo, 'nested django')
    const { content, packageCount, scriptCount } = buildPyMap(repo, META)
    assert.equal(packageCount, 2)
    assert.equal(scriptCount, 0) // backend/manage.py is not at a script location
    assert.match(content, /\| shop \(django app\) \| backend\/shop \| core\(1\) \| 0 \|/)
    assert.match(content, /\| core \| backend\/core \| \(none\) \| 1 \|/)
})

test('buildPyMap: a scripts-only repo maps scripts and no packages', () => {
    const repo = makeGitRepo()
    writeRepoFile(repo, 'cleanup.py', 'import sys\nif __name__ == "__main__":\n    sys.exit(0)\n')
    writeRepoFile(repo, 'bin/report.py', 'print("hi")\n')
    commit(repo, 'scripts')
    const { content, packageCount, scriptCount } = buildPyMap(repo, META)
    assert.equal(packageCount, 0)
    assert.equal(scriptCount, 2)
    assert.match(content, /\| \(none\) \| \| \| \|/)
    assert.match(content, /\| bin\/report\.py \| no \|/)
    assert.match(content, /\| cleanup\.py \| yes \|/)
})

test('buildPyMap: a repo without python throws the absence error', () => {
    const repo = makeGitRepo()
    writeRepoFile(repo, 'src/index.js', 'export const a = 1\n')
    commit(repo, 'js only')
    assert.throws(() => buildPyMap(repo, META), PyMapError)
})
