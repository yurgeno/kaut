/**
 * Usage digest — aggregate the append-only journals across a workspace into one picture (A).
 *
 * Pure functions over journal records (the mechanical layer already written by lookup/index/map/note):
 * `aggregate` folds records → stats; `renderDigest` turns stats → a human report. No I/O here — the CLI
 * (`kaut digest`) sweeps the registry's store roots, reads each `journal.jsonl`, tags records with the
 * store label, and feeds them in. The journal already logs reach (lookups w/ verdict/trust/altitude/miss)
 * and self-maintenance (writes w/ tier); `op:outcome` (kaut note) adds the honor-system value signal.
 *
 * The digest answers "how is KAUT actually used, where does it hit/miss, how fresh, how much
 * self-maintenance, and — where tagged — did it help": the substrate for the still-open value question.
 */

/** Bump a counter map in place (ignores null/undefined keys). */
function inc(obj, key) {
    if (key == null) return
    obj[key] = (obj[key] || 0) + 1
}

/**
 * Fold journal records into aggregate stats.
 * @param {Array<Record<string, any>>} events records, each optionally tagged with `store`
 * @param {string[]} [storeLabels] all store labels swept (so empty stores still count)
 * @returns {Record<string, any>}
 */
export function aggregate(events, storeLabels = []) {
    const stats = {
        range: { from: null, to: null },
        totals: { events: events.length, stores: storeLabels.length, lookups: 0, writes: 0, maps: 0, outcomes: 0 },
        lookups: { byMode: {}, hits: 0, misses: 0, hitRate: null, byVerdict: {}, byTrust: {}, byAltitude: {} },
        writes: { total: 0, byTier: {} },
        outcomes: { total: 0, byResult: {} },
        topTopics: [],
        byStore: {},
    }
    const topics = {} // topic -> { lookups, miss, stale, outcomes:{} }
    for (const label of storeLabels) stats.byStore[label] = { lookups: 0, misses: 0, writes: 0, outcomes: 0 }

    for (const e of events) {
        if (e.ts) {
            if (!stats.range.from || e.ts < stats.range.from) stats.range.from = e.ts
            if (!stats.range.to || e.ts > stats.range.to) stats.range.to = e.ts
        }
        const bs = (stats.byStore[e.store ?? '(unknown)'] ||= { lookups: 0, misses: 0, writes: 0, outcomes: 0 })
        switch (e.op) {
            case 'lookup': {
                stats.totals.lookups++
                bs.lookups++
                inc(stats.lookups.byMode, e.mode)
                if (e.mode === 'miss') {
                    stats.lookups.misses++
                    bs.misses++
                } else if (e.mode === 'full' || e.mode === 'partial') {
                    stats.lookups.hits++
                }
                inc(stats.lookups.byVerdict, e.verdict)
                inc(stats.lookups.byTrust, e.trust)
                inc(stats.lookups.byAltitude, e.altitude)
                if (e.topic) {
                    const t = (topics[e.topic] ||= { lookups: 0, miss: 0, stale: 0, outcomes: {} })
                    t.lookups++
                    if (e.mode === 'miss') t.miss++
                    if (e.verdict === 'stale') t.stale++
                }
                break
            }
            case 'write':
                stats.totals.writes++
                stats.writes.total++
                bs.writes++
                inc(stats.writes.byTier, e.tier)
                break
            case 'map':
                stats.totals.maps++
                break
            case 'outcome':
                stats.totals.outcomes++
                stats.outcomes.total++
                bs.outcomes++
                inc(stats.outcomes.byResult, e.result)
                if (e.topic) {
                    const t = (topics[e.topic] ||= { lookups: 0, miss: 0, stale: 0, outcomes: {} })
                    inc(t.outcomes, e.result)
                }
                break
        }
    }
    const decided = stats.lookups.hits + stats.lookups.misses
    stats.lookups.hitRate = decided ? Math.round((stats.lookups.hits / decided) * 100) / 100 : null
    stats.topTopics = Object.entries(topics)
        .map(([topic, v]) => ({ topic, ...v }))
        .sort((a, b) => b.lookups - a.lookups || (a.topic < b.topic ? -1 : 1))
    return stats
}

/** A compact `key: n, key: n` line from a counter map (sorted desc), or '—' when empty. */
function counters(obj) {
    const ks = Object.keys(obj)
    if (!ks.length) return '—'
    return ks
        .sort((a, b) => obj[b] - obj[a] || (a < b ? -1 : 1))
        .map((k) => `${k}: ${obj[k]}`)
        .join(', ')
}

/**
 * Render stats as a human-readable report.
 * @param {ReturnType<typeof aggregate>} s
 * @param {{topN?: number}} [opts]
 * @returns {string}
 */
export function renderDigest(s, { topN = 15 } = {}) {
    if (!s.totals.events) return 'kaut digest: no telemetry yet (no journal records in range).'
    const L = []
    L.push('# KAUT usage digest')
    L.push(`range: ${s.range.from ?? '?'} … ${s.range.to ?? '?'}  ·  ${s.totals.stores} store(s)`)
    L.push(
        `events: ${s.totals.events}  (lookups ${s.totals.lookups}, writes ${s.totals.writes}, maps ${s.totals.maps}, outcomes ${s.totals.outcomes})`,
    )

    L.push('\n## Reads')
    L.push(`modes:    ${counters(s.lookups.byMode)}`)
    const hr = s.lookups.hitRate == null ? 'n/a' : `${Math.round(s.lookups.hitRate * 100)}%`
    L.push(`hit/miss: ${s.lookups.hits} hit / ${s.lookups.misses} miss  (hit rate ${hr})  ← coverage`)
    L.push(`verdict:  ${counters(s.lookups.byVerdict)}  ← freshness at read time (stale = rot hit)`)
    L.push(`trust:    ${counters(s.lookups.byTrust)}`)
    L.push(`altitude: ${counters(s.lookups.byAltitude)}  ← coarse vs precise`)

    L.push('\n## Self-maintenance (writes)')
    L.push(`${s.writes.total} write(s) by tier — ${counters(s.writes.byTier)}`)

    L.push('\n## Value signal (kaut note — honor-system)')
    if (!s.outcomes.total) L.push('no outcomes recorded yet (sessions did not tag how a doc fared)')
    else L.push(`${s.outcomes.total} outcome(s) — ${counters(s.outcomes.byResult)}`)

    L.push('\n## Top topics (by reads)')
    const top = s.topTopics.slice(0, topN)
    if (!top.length) L.push('—')
    else
        for (const t of top) {
            const flags = []
            if (t.miss) flags.push(`${t.miss} miss`)
            if (t.stale) flags.push(`${t.stale} stale`)
            const oc = Object.keys(t.outcomes).length ? `  {${counters(t.outcomes)}}` : ''
            L.push(`  ${String(t.lookups).padStart(4)}  ${t.topic}${flags.length ? `  [${flags.join(', ')}]` : ''}${oc}`)
        }
    const missTopics = s.topTopics.filter((t) => t.miss > 0 && t.lookups === t.miss).map((t) => t.topic)
    if (missTopics.length) L.push(`\ncoverage gaps (only ever missed): ${missTopics.join(', ')}`)

    L.push('\n## By store')
    for (const [label, b] of Object.entries(s.byStore).sort((a, b) => b[1].lookups - a[1].lookups))
        L.push(`  ${label}: ${b.lookups} reads (${b.misses} miss), ${b.writes} writes, ${b.outcomes} outcomes`)

    return L.join('\n')
}
