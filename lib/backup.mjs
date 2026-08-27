/**
 * Backup/restore of the knowledge-data home — zero external dependencies by law.
 *
 * The archive is a hand-rolled POSIX ustar tar, gzipped with node:zlib — so it is
 * restorable by this engine on any machine AND inspectable with any standard tar tool.
 * Contents: everything under the data home (stores with their private git history,
 * the workspace registry, setup.json) EXCEPT the backups folder itself and transient
 * files (.lock/, .DS_Store). The whole home is held in memory during pack/unpack —
 * knowledge stores are text-sized by design, this is fine by construction.
 */
import { gzipSync, gunzipSync } from 'node:zlib'
import {
    existsSync,
    lstatSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    readlinkSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from 'node:fs'
import path from 'node:path'

const BLOCK = 512
export const BACKUPS_DIR = 'backups'
const SKIP_NAMES = new Set([BACKUPS_DIR, '.lock', '.DS_Store'])

/** Fixed-width octal field (NUL-terminated), the ustar way. */
function octal(n, len) {
    return n.toString(8).padStart(len - 1, '0') + '\0'
}

/** name(100)+prefix(155) split for long paths; throws when a path cannot fit. */
function splitName(rel) {
    if (Buffer.byteLength(rel) <= 100) return { name: rel, prefix: '' }
    // split at a '/' so that the suffix fits name(100) and the rest fits prefix(155):
    // the FIRST slash at or after len-101 gives the longest valid prefix's complement
    for (let i = Math.max(0, rel.length - 101); i < rel.length; i++) {
        if (rel[i] !== '/') continue
        const prefix = rel.slice(0, i)
        const name = rel.slice(i + 1)
        if (Buffer.byteLength(name) <= 100 && Buffer.byteLength(prefix) <= 155) return { name, prefix }
    }
    throw new Error(`path too long for a ustar archive: ${rel}`)
}

/**
 * One 512-byte ustar header.
 * @param {string} rel archive-relative path
 * @param {{mode: number, size: number, mtime: number, type: '0'|'5'|'2', linkname?: string}} f
 */
function header(rel, f) {
    const { name, prefix } = splitName(rel)
    const buf = Buffer.alloc(BLOCK)
    buf.write(name, 0, 100)
    buf.write(octal(f.mode & 0o7777, 8), 100)
    buf.write(octal(0, 8), 108) // uid
    buf.write(octal(0, 8), 116) // gid
    buf.write(octal(f.size, 12), 124)
    buf.write(octal(f.mtime, 12), 136)
    buf.write('        ', 148) // chksum: spaces while summing
    buf.write(f.type, 156)
    if (f.linkname) buf.write(f.linkname, 157, 100)
    buf.write('ustar\0', 257)
    buf.write('00', 263)
    buf.write(prefix, 345, 155)
    let sum = 0
    for (const b of buf) sum += b
    buf.write(sum.toString(8).padStart(6, '0') + '\0 ', 148)
    return buf
}

/** Recursively list entries under root (skipping SKIP_NAMES), dirs first, sorted. */
function walk(root, rel = '') {
    const out = []
    const abs = path.join(root, rel)
    for (const e of readdirSync(abs, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
        if (SKIP_NAMES.has(e.name)) continue
        const childRel = rel ? `${rel}/${e.name}` : e.name
        const st = lstatSync(path.join(root, childRel))
        if (e.isDirectory()) {
            out.push({ rel: childRel, type: '5', mode: st.mode, mtime: st.mtimeMs / 1000 | 0, size: 0 })
            out.push(...walk(root, childRel))
        } else if (e.isSymbolicLink()) {
            out.push({ rel: childRel, type: '2', mode: st.mode, mtime: st.mtimeMs / 1000 | 0, size: 0, linkname: readlinkSync(path.join(root, childRel)) })
        } else if (e.isFile()) {
            out.push({ rel: childRel, type: '0', mode: st.mode, mtime: st.mtimeMs / 1000 | 0, size: st.size })
        }
        // sockets/fifos etc. have no place in a knowledge store — silently irrelevant
    }
    return out
}

/**
 * Pack the data home into a gzipped ustar buffer.
 * @param {string} home the knowledge-data home
 * @param {{version: string}} meta engine version stamped into the embedded manifest
 * @returns {{archive: Buffer, files: number}}
 */
export function packHome(home, meta) {
    const entries = walk(home)
    const chunks = []
    // Provenance manifest as the FIRST archive member — restore validates against it.
    const manifest = Buffer.from(
        JSON.stringify(
            { schema: 1, tool: 'kaut-backup', engine: meta.version, created: new Date().toISOString(), home, entries: entries.length },
            null,
            4,
        ) + '\n',
    )
    chunks.push(header('backup-manifest.json', { mode: 0o644, size: manifest.length, mtime: Date.now() / 1000 | 0, type: '0' }))
    chunks.push(manifest, Buffer.alloc(pad(manifest.length)))
    let files = 0
    for (const e of entries) {
        if (e.type === '0') {
            const data = readFileSync(path.join(home, e.rel))
            chunks.push(header(e.rel, { ...e, size: data.length }))
            chunks.push(data, Buffer.alloc(pad(data.length)))
            files++
        } else {
            chunks.push(header(e.rel, e))
        }
    }
    chunks.push(Buffer.alloc(BLOCK * 2)) // end-of-archive
    return { archive: gzipSync(Buffer.concat(chunks)), files }
}

function pad(size) {
    return (BLOCK - (size % BLOCK)) % BLOCK
}

/**
 * Parse a gzipped ustar buffer into entries (checksums verified).
 * @param {Buffer} archive
 * @returns {{manifest: object|null, entries: Array<{rel: string, type: string, mode: number, data?: Buffer, linkname?: string}>}}
 */
export function parseArchive(archive) {
    const tar = gunzipSync(archive)
    const entries = []
    let manifest = null
    let off = 0
    while (off + BLOCK <= tar.length) {
        const h = tar.subarray(off, off + BLOCK)
        if (h.every((b) => b === 0)) break // end-of-archive
        const stored = parseInt(h.toString('ascii', 148, 156).replace(/[^0-7]/g, ''), 8)
        let sum = 0
        for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : h[i]
        if (sum !== stored) throw new Error(`corrupt archive: header checksum mismatch at offset ${off}`)
        const str = (a, b) => h.toString('utf8', a, b).replace(/\0.*$/, '')
        const name = str(0, 100)
        const prefix = str(345, 500)
        const rel = prefix ? `${prefix}/${name}` : name
        const size = parseInt(h.toString('ascii', 124, 136).replace(/[^0-7]/g, '') || '0', 8)
        const type = String.fromCharCode(h[156] || 48)
        const mode = parseInt(h.toString('ascii', 100, 108).replace(/[^0-7]/g, '') || '644', 8)
        off += BLOCK
        const data = type === '0' || type === '\0' ? tar.subarray(off, off + size) : undefined
        off += size + pad(size)
        if (rel === 'backup-manifest.json' && data) {
            manifest = JSON.parse(data.toString('utf8'))
            continue
        }
        entries.push({ rel, type, mode, data: data ? Buffer.from(data) : undefined, linkname: type === '2' ? str(157, 257) : undefined })
    }
    return { manifest, entries }
}

/**
 * Restore parsed entries into `home`. The data folder is precious: without `force`,
 * the restore REFUSES if any archived file already exists at the destination —
 * nothing is ever silently overwritten.
 * @param {string} home destination data home
 * @param {ReturnType<typeof parseArchive>['entries']} entries
 * @param {{force?: boolean}} [opts]
 * @returns {{written: number, conflicts: string[]}}
 */
export function restoreEntries(home, entries, { force = false } = {}) {
    // rel paths came from an archive — confine them before any filesystem effect
    for (const e of entries) {
        if (path.isAbsolute(e.rel) || e.rel.split('/').includes('..'))
            throw new Error(`unsafe path in archive: ${e.rel}`)
    }
    const conflicts = entries
        .filter((e) => (e.type === '0' || e.type === '\0' || e.type === '2') && existsSync(path.join(home, e.rel)))
        .map((e) => e.rel)
    if (conflicts.length && !force) return { written: 0, conflicts }
    let written = 0
    for (const e of entries) {
        const abs = path.join(home, e.rel)
        if (e.type === '5') {
            mkdirSync(abs, { recursive: true })
        } else if (e.type === '2') {
            mkdirSync(path.dirname(abs), { recursive: true })
            if (existsSync(abs)) rmSync(abs) // force path: conflicts were confirmed above
            symlinkSync(e.linkname, abs)
            written++
        } else {
            mkdirSync(path.dirname(abs), { recursive: true })
            writeFileSync(abs, e.data ?? Buffer.alloc(0), { mode: e.mode & 0o7777 })
            written++
        }
    }
    return { written, conflicts }
}
