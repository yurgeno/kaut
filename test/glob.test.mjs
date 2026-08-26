import assert from 'node:assert/strict'
import { test } from 'node:test'
import { anyMatch, filterMatch, matchGlob } from '../lib/glob.mjs'

test('trailing ** crosses directories', () => {
    assert.ok(matchGlob('packages/core/src/utils/**', 'packages/core/src/utils/constants.ts'))
    assert.ok(matchGlob('packages/core/src/utils/**', 'packages/core/src/utils/x/y.ts'))
    assert.ok(!matchGlob('packages/core/src/utils/**', 'packages/core/src/other.ts'))
})

test('* stays within one segment', () => {
    assert.ok(matchGlob('packages/*', 'packages/core'))
    assert.ok(!matchGlob('packages/*', 'packages/core/src'))
    assert.ok(matchGlob('packages/*/src/**', 'packages/a/src/x.ts'))
    assert.ok(matchGlob('packages/*/src/**', 'packages/b/src/c/d.ts'))
    assert.ok(!matchGlob('packages/*/src/**', 'packages/a/test/x.ts'))
})

test('leading **/ matches zero or more segments', () => {
    assert.ok(matchGlob('**/foo.ts', 'foo.ts'))
    assert.ok(matchGlob('**/foo.ts', 'a/foo.ts'))
    assert.ok(matchGlob('**/foo.ts', 'a/b/foo.ts'))
    assert.ok(!matchGlob('**/foo.ts', 'a/foo.tsx'))
})

test('? matches exactly one non-slash char', () => {
    assert.ok(matchGlob('a?.ts', 'ab.ts'))
    assert.ok(!matchGlob('a?.ts', 'abc.ts'))
    assert.ok(!matchGlob('a?.ts', 'a/.ts'))
})

test('literal path has no wildcards and dots are escaped', () => {
    assert.ok(matchGlob('src/router/routes.ts', 'src/router/routes.ts'))
    assert.ok(!matchGlob('src/router/routes.ts', 'src/router/routes.tsx'))
    assert.ok(!matchGlob('a.b', 'axb')) // '.' must be literal, not regex any-char
})

test('anyMatch / filterMatch over a set', () => {
    const tree = ['src/a.ts', 'src/b.ts', 'docs/c.md']
    assert.ok(anyMatch('src/**', tree))
    assert.ok(!anyMatch('lib/**', tree))
    assert.deepEqual(filterMatch('src/**', tree), ['src/a.ts', 'src/b.ts'])
    assert.deepEqual(filterMatch('**/*.md', tree), ['docs/c.md'])
})
