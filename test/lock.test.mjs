import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { acquireLock, LockBusyError } from '../lib/lock.mjs'
import { makeTmpDir } from './helpers.mjs'

/** @returns {number} pid of a process that is guaranteed dead */
function deadPid() {
    const r = spawnSync(process.execPath, ['-e', ''])
    return r.pid
}

test('acquire and release', async () => {
    const root = makeTmpDir()
    const release = await acquireLock(root, 'test')
    release()
    const again = await acquireLock(root, 'test') // re-acquire works after release
    again()
})

test('second acquire times out with LockBusyError', async () => {
    const root = makeTmpDir()
    const release = await acquireLock(root, 'op-one')
    try {
        await assert.rejects(
            acquireLock(root, 'op-two', { timeoutMs: 400, retryMs: 50 }),
            (e) => e instanceof LockBusyError && /op-one/.test(e.message),
        )
    } finally {
        release()
    }
})

test('steals a lock whose owner is dead AND older than staleMs', async () => {
    const root = makeTmpDir()
    const lockDir = path.join(root, '.lock')
    mkdirSync(lockDir)
    writeFileSync(
        path.join(lockDir, 'owner.json'),
        JSON.stringify({ pid: deadPid(), startedAt: new Date(Date.now() - 60_000).toISOString(), op: 'crashed' }),
    )
    const release = await acquireLock(root, 'test', { timeoutMs: 1000, retryMs: 50, staleMs: 30_000 })
    release()
})

test('does NOT steal a dead-owner lock that is still fresh', async () => {
    const root = makeTmpDir()
    const lockDir = path.join(root, '.lock')
    mkdirSync(lockDir)
    writeFileSync(
        path.join(lockDir, 'owner.json'),
        JSON.stringify({ pid: deadPid(), startedAt: new Date().toISOString(), op: 'recent' }),
    )
    await assert.rejects(
        acquireLock(root, 'test', { timeoutMs: 300, retryMs: 50, staleMs: 60_000 }),
        LockBusyError,
    )
})
