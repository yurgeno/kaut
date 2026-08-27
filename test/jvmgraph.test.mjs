/**
 * JVM module-graph adapter: gradle include/project(:) parsing, the maven variant,
 * nested build roots, and stack-absence signaling.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { JvmGraphError, buildJvmGraph, findBuildRoot, parseGradleIncludes } from '../lib/jvmgraph.mjs'
import { commit, makeGitRepo, makeTmpDir, writeRepoFile } from './helpers.mjs'

const META = { derived: 'a'.repeat(40), harvested: '2026-08-27', version: '0.3.0' }

test('parseGradleIncludes: both include forms, deduped and sorted', () => {
    const src = "rootProject.name = 'demo'\ninclude ':core', ':api'\ninclude(\":web\")\ninclude ':core'\n"
    assert.deepEqual(parseGradleIncludes(src), ['api', 'core', 'web'])
})

test('buildJvmGraph: gradle modules + project(:) edges, sorted and source-bound', () => {
    const repo = makeGitRepo()
    writeRepoFile(repo, 'settings.gradle', "include ':core', ':api'\ninclude(\":web\")\n")
    writeRepoFile(repo, 'core/build.gradle', "dependencies {\n    implementation 'org.demo:lib:1.0'\n}\n")
    writeRepoFile(repo, 'api/build.gradle', "dependencies {\n    implementation project(':core')\n}\n")
    writeRepoFile(repo, 'web/build.gradle.kts', 'dependencies {\n    implementation(project(":api"))\n}\n')
    commit(repo, 'gradle layout')

    const { content, moduleCount } = buildJvmGraph(repo, META)
    assert.equal(moduleCount, 3)
    assert.match(content, /id: map\/packages/)
    assert.match(content, /engine: jvm-graph@0\.3\.0/)
    assert.match(content, /Build root: `settings\.gradle` \(repo toplevel\)/)
    assert.match(content, /\| api \| api \| core \|/)
    assert.match(content, /\| core \| core \| \(none\) \|/)
    assert.match(content, /\| web \| web \| api \|/)
    assert.match(content, /- api → core/)
    assert.match(content, /- web → api/)
    assert.match(content, /file:settings\.gradle/)
    assert.match(content, /file:api\/build\.gradle/) // module build files are bound as sources
})

test('buildJvmGraph: build root nested one level down is found and noted', () => {
    const repo = makeGitRepo()
    writeRepoFile(repo, 'backend/settings.gradle', "include ':svc'\n")
    writeRepoFile(repo, 'backend/svc/build.gradle', 'plugins { id "java" }\n')
    commit(repo, 'nested gradle')
    assert.deepEqual(findBuildRoot(repo), { dir: 'backend', file: 'settings.gradle' })
    const { content, moduleCount } = buildJvmGraph(repo, META)
    assert.equal(moduleCount, 1)
    assert.match(content, /Build root: `backend\/settings\.gradle` \(nested one level down\)/)
    assert.match(content, /\| svc \| backend\/svc \|/)
})

test('buildJvmGraph: maven modules + same-groupId dependency edges', () => {
    const repo = makeGitRepo()
    writeRepoFile(
        repo,
        'pom.xml',
        [
            '<project>',
            '    <groupId>org.demo</groupId>',
            '    <artifactId>demo-parent</artifactId>',
            '    <modules>',
            '        <module>alpha</module>',
            '        <module>beta</module>',
            '    </modules>',
            '</project>',
            '',
        ].join('\n'),
    )
    writeRepoFile(
        repo,
        'alpha/pom.xml',
        [
            '<project>',
            '    <parent><groupId>org.demo</groupId><artifactId>demo-parent</artifactId></parent>',
            '    <artifactId>alpha</artifactId>',
            '    <dependencies>',
            '        <dependency><groupId>org.demo</groupId><artifactId>beta</artifactId></dependency>',
            '        <dependency><groupId>org.other</groupId><artifactId>ext</artifactId></dependency>',
            '    </dependencies>',
            '</project>',
            '',
        ].join('\n'),
    )
    writeRepoFile(repo, 'beta/pom.xml', '<project><artifactId>beta</artifactId></project>\n')
    commit(repo, 'maven layout')

    const { content, moduleCount } = buildJvmGraph(repo, META)
    assert.equal(moduleCount, 2)
    assert.match(content, /\| alpha \| alpha \| beta \|/) // same-groupId dep → edge
    assert.match(content, /\| beta \| beta \| \(none\) \|/)
    assert.doesNotMatch(content, /ext/) // foreign-groupId dep is NOT an edge
})

test('buildJvmGraph: a repo without a build root throws the absence error', () => {
    assert.throws(() => buildJvmGraph(makeGitRepo(), META), JvmGraphError)
})

test('gradle: a settings file with no includes is a single-module build, not 0 modules', () => {
    const repo = makeTmpDir()
    writeFileSync(path.join(repo, 'settings.gradle'), "rootProject.name = 'solo-service'\n")
    writeFileSync(path.join(repo, 'build.gradle'), "plugins { id 'java' }\n")
    const { moduleCount, content } = buildJvmGraph(repo, META)
    assert.equal(moduleCount, 1)
    assert.match(content, /solo/)
})
