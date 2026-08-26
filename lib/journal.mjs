/**
 * Usage journal — append-only telemetry (SCHEMA §13).
 *
 * One JSON object per line in `<root>/journal.jsonl`: the mechanical layer of the §10 metrics
 * journal and the Phase 1 gate mechanism. Written by `lookup` and `map`, read for gate
 * counting. It is NOT knowledge (untracked in the store git) and NOT the obligations queue
 * (that miss-log arrives in Phase 2 with distill as its reader).
 *
 * Writes use a single O_APPEND `appendFileSync` (atomic for the small lines we emit) and take
 * no store lock — telemetry must never contend with or block the read path.
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

const JOURNAL = 'journal.jsonl'

/**
 * Append one telemetry record. Stamps `ts` (ISO) unless the caller supplies one.
 * `op:'lookup'`/`'map'` = reads (the gate counts these). `op:'write'` = a pipeline store write at the
 * commit chokepoint, with the grant `tier` used (`agent`|`owner-approved`|`free`) — the write-gate audit on top
 * of store git history (the record is a grant label, NOT proof of in-session verification, which is
 * honor-system).
 * @param {string} root store root
 * @param {{op: string, topic?: string, verdict?: string|null, trust?: string|null,
 *   mode?: string, tier?: string, branch?: string, ts?: string}} record
 */
export function appendJournal(root, record) {
    const { ts = new Date().toISOString(), ...rest } = record
    appendFileSync(path.join(root, JOURNAL), JSON.stringify({ ts, ...rest }) + '\n')
}

/**
 * Read all journal records. Malformed lines are skipped (telemetry is best-effort and must
 * never crash a read), reported through `warn`.
 * @param {string} root store root
 * @param {{warn?: (s: string) => void}} [opts]
 * @returns {Array<Record<string, unknown>>}
 */
export function readJournal(root, { warn = () => {} } = {}) {
    const p = path.join(root, JOURNAL)
    if (!existsSync(p)) return []
    const out = []
    const all = readFileSync(p, 'utf8').split('\n')
    for (let i = 0; i < all.length; i++) {
        if (!all[i].trim()) continue
        try {
            out.push(JSON.parse(all[i]))
        } catch {
            warn(`journal: skipping malformed line ${i + 1}`)
        }
    }
    return out
}
