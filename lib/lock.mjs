/**
 * Store write lock — mkdir-atomic (SCHEMA §9).
 *
 * One lock per store guards every write path (bootstrap, index, future distill). INDEX
 * regeneration is idempotent from frontmatter, so with the lock in place last-writer-wins
 * is safe.
 */
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

/** Error class mapped to CLI exit code 2 ("store busy"). */
export class LockBusyError extends Error {
    /**
     * @param {string} message
     * @param {{pid?: number, startedAt?: string, op?: string}|null} owner
     */
    constructor(message, owner) {
        super(message)
        this.code = 'KAUT_LOCK_BUSY'
        this.owner = owner
    }
}

const DEFAULT_TIMEOUT_MS = 10_000
const DEFAULT_RETRY_MS = 250
const DEFAULT_STALE_MS = 15 * 60 * 1000

/**
 * @param {number} pid
 * @returns {boolean} whether the process exists (EPERM counts as alive)
 */
function pidAlive(pid) {
    try {
        process.kill(pid, 0)
        return true
    } catch (e) {
        return e.code === 'EPERM'
    }
}

/**
 * @param {string} p
 * @returns {number} mtime in ms, or now when unreadable (treats races as "fresh lock")
 */
function dirMtime(p) {
    try {
        return statSync(p).mtimeMs
    } catch {
        return Date.now()
    }
}

/**
 * Acquire the store write lock. Steals a lock only when its owner pid is dead AND the lock
 * is older than `staleMs` (both conditions — a live long op keeps its lock).
 * @param {string} root store root
 * @param {string} op operation name recorded in owner.json (diagnostics)
 * @param {{timeoutMs?: number, retryMs?: number, staleMs?: number}} [opts]
 * @returns {Promise<() => void>} release function — call it in `finally`
 * @throws {LockBusyError} after `timeoutMs` of the lock staying busy
 */
export async function acquireLock(
    root,
    op,
    { timeoutMs = DEFAULT_TIMEOUT_MS, retryMs = DEFAULT_RETRY_MS, staleMs = DEFAULT_STALE_MS } = {},
) {
    const lockDir = path.join(root, '.lock')
    const ownerFile = path.join(lockDir, 'owner.json')
    const deadline = Date.now() + timeoutMs

    for (;;) {
        try {
            mkdirSync(lockDir)
            writeFileSync(
                ownerFile,
                JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), op }),
            )
            return () => rmSync(lockDir, { recursive: true, force: true })
        } catch (e) {
            if (e.code !== 'EEXIST') throw e
        }

        let owner = null
        try {
            owner = JSON.parse(readFileSync(ownerFile, 'utf8'))
        } catch {
            // Unreadable/missing owner.json — judge staleness by the lock dir's mtime below.
        }
        const startedMs = owner ? Date.parse(owner.startedAt) : dirMtime(lockDir)
        const age = Date.now() - (Number.isFinite(startedMs) ? startedMs : Date.now())
        const alive = owner ? pidAlive(owner.pid) : false

        if (!alive && age > staleMs) {
            console.error(
                `kaut: stealing stale lock (owner pid ${owner?.pid ?? 'unknown'}, age ${Math.round(age / 60_000)} min)`,
            )
            rmSync(lockDir, { recursive: true, force: true })
            continue
        }
        if (Date.now() >= deadline) {
            throw new LockBusyError(
                `store busy: "${owner?.op ?? 'unknown'}" held by pid ${owner?.pid ?? 'unknown'}`,
                owner,
            )
        }
        await sleep(retryMs)
    }
}
