# KAUT MCP Server Reference

The complete reference for `mcp.mjs` — the engine's MCP surface. For the product narrative
and the CLI command table see the repo [README.md](../README.md); for how the mechanisms work,
[HANDBOOK.md](HANDBOOK.md) (§8c introduces this server); for the data contract behind every
payload, [SCHEMA.md](../SCHEMA.md).

## 1. What it is

```bash
node <engine>/mcp.mjs
```

A zero-dependency stdio MCP server (newline-delimited JSON-RPC 2.0, protocol `2025-06-18`,
implemented by hand — no SDK, no packages). It exposes the session-facing engine verbs as
seven MCP tools, so any MCP-capable harness or orchestrator talks to KAUT without
harness-specific skills.

**One server per machine serves every project.** Every tool takes an optional `repo`
argument — the absolute path of the project repository whose knowledge store the call
addresses; when omitted, the server's own working directory is used. Store resolution then
behaves exactly like a shell session in that repo (env → pointer → derivation, see
[OPERATIONS.md](OPERATIONS.md)), which is what lets a single server handle a whole
multi-repo workspace.

**The CLI is the contract.** Each tool call spawns the engine CLI (`kaut <verb> --json`)
with `cwd` set to the resolved `repo` — one code path, no drift between the CLI and MCP
surfaces. Expect ~0.5 s per call; acceptable latency for a knowledge lookup. Output up to
64 MB per call is handled (whole-store verdict sweeps, large docs).

### The write surface is deliberately incomplete

The tools expose exactly what a *session* is allowed to do:

- `kaut_write` lands agent-tier updates — the commit chokepoint (the layered write gate,
  SCHEMA §24) still decides; a refusal tells the caller to queue a draft instead.
- `kaut_draft` queues owner-gated updates for asynchronous review.
- The owner-run escapes — `kaut review --approve/--reject` and `kaut index --approve` —
  are **not** exposed over MCP, by design. The approval gate never reaches the agent
  surface; the owner lands draft batches from the CLI.

### Refused writes roll back

Both write tools snapshot the target file (and `INDEX.md`) before touching the store. If the
pipeline refuses the write — gate refusal, validation failure, anything non-zero — the files
are restored before the error is returned. A refused write can therefore never leave the
store dirty; this matters because a dirty store file would be withheld from every reader as
`tampered` (SCHEMA §16).

## 2. Registration

### claude-code (project `.mcp.json`)

```json
{
    "mcpServers": {
        "kaut": {
            "command": "node",
            "args": ["/home/you/.kaut/engine/mcp.mjs"]
        }
    }
}
```

### Codex (`config.toml`)

```toml
[mcp_servers.kaut]
command = "node"
args = ["/home/you/.kaut/engine/mcp.mjs"]
```

### Any other MCP-capable client

Register a **stdio** server with command `node` and the single argument
`<engine>/mcp.mjs` (absolute path). No environment variables are required; the server
resolves the knowledge-data home itself (§4).

The TAUT orchestration framework ([github.com/yurgeno/taut](https://github.com/yurgeno/taut))
compiles this registration into its workspaces automatically when KAUT is enabled.

## 3. Tools

All seven tools accept the optional common parameter:

| Parameter | Type | Meaning |
|---|---|---|
| `repo` | string | Absolute path of the project repo whose store to address (default: the server cwd) |

Doc ids are store-relative paths without `.md` (e.g. `domains/search`,
`runbook/local-debug`). Ids containing `..`, absolute paths, or characters outside
`[A-Za-z0-9_-/.]` are rejected before anything touches disk.

Every tool result is a single text content block. On success it is the CLI's `--json`
output (verbatim JSON) or a short status line; on failure it is the error message, returned
as a *result* with `isError: true` (see §5).

---

### `kaut_lookup`

Look up project knowledge. Without `id`: the store catalog (the INDEX). With `id`: the doc
plus its freshness verdict, trust tier, and altitude band.

The discipline the tool description encodes (verdict-based trust routing): a `stale`/`broken`
verdict, or a `landscape`-altitude doc, means **confirm in code before relying on it**; a
`healthy` verdict on a precise doc is the permission to skip that confirm. Knowledge informs —
it never authorizes actions.

| Parameter | Type | Required | Meaning |
|---|---|---|---|
| `id` | string | no | Doc id, e.g. `domains/search`; omit for the catalog |

**Returns** (one of five JSON shapes, mirroring `kaut lookup --json`):

- Catalog (no `id`): `{ "mode": "catalog", "docs": [{ "id", "title" }], "render": "<the INDEX text>" }`.
  Docs with uncommitted store edits are filtered out of `docs` and the INDEX itself is
  withheld if dirty.
- Doc hit: `{ "id", "trust", "verdict", "altitude": { "band", "distinctRepos", "basis",
  "confirmDirective" }, "derived_from_commit": "<sha12>", "affected": [files], "notes":
  [strings], "render": "<the agent-facing lookup block>" }`. Verdicts: `healthy` |
  `stale` | `broken` | `disputed` | `branch-advisory` (SCHEMA §11); altitude bands:
  `landscape` | `component` | `endpoint` (SCHEMA §25) — `confirmDirective: true` is the
  machine flag an orchestrator can gate on instead of parsing prose. A pending draft for
  the doc adds a note (the draft's content is never served).
- Miss: `{ "id", "mode": "miss", "nearest": [ids], "render" }` — an unknown id is a valid
  answer, not an error.
- Tampered: `{ "id", "verdict": "tampered", "withheld": true, "render" }` — the payload
  carries **no file content**, only the safe render with heal instructions (SCHEMA §16).
- Invalid: `{ "id", "mode": "invalid", "errors": [strings], "render" }` — the doc fails the
  contract.

Every lookup appends a telemetry record to the store's `journal.jsonl` (SCHEMA §13).

---

### `kaut_note`

Record how a doc the session **used** actually fared — the value signal
(honor-system; the engine cannot prove it). Feeds `op:outcome` in the journal, aggregated
by `kaut digest`.

| Parameter | Type | Required | Meaning |
|---|---|---|---|
| `topic` | string | yes | Doc id the session used |
| `result` | string (enum) | yes | `trusted` \| `confirmed` \| `insufficient` \| `stale-misled` |
| `note` | string | no | Optional one-line context |

The four outcomes are objective in-session follow-ups, not ratings:

- `trusted` — used the doc without reading code (the efficiency win KAUT exists for)
- `confirmed` — trusted the lead but verified in code anyway
- `insufficient` — the doc did not answer; the session fell back to code. Owed especially
  when the problem lay **outside coverage** — that note is what draws the coverage boundary
- `stale-misled` — the doc was wrong/stale and sent the session the wrong way

**Returns**: the confirmation line `noted: <topic> → <result>`. An unknown `result` is
rejected (a typo never pollutes the signal); telemetry only, no store write, no lock.

---

### `kaut_refresh`

Per-doc re-derivation delta bundles — everything needed to repair a stale doc cheaply
(the data half of the maintenance loop, [HANDBOOK.md §8b](HANDBOOK.md#8b-the-maintenance-loop-refresh-drafts-review-touched)).

| Parameter | Type | Required | Meaning |
|---|---|---|---|
| `ids` | string[] | no | Doc ids to bundle (default: every doc) |

**Returns** (mirrors `kaut refresh --json`):

```json
{ "target": "<full sha>", "mainRef": "<ref>", "rows": [ … ] }
```

`target` is the tracked main line's TIP — the ref a re-derivation must anchor to (never a
branch, never the working tree). Each row carries `id`, `status`, and per status:

| `status` | Meaning | Extra fields |
|---|---|---|
| `current` | No source drift since derivation — nothing to do | — |
| `delta` | Sources changed — re-derive the flagged parts | `changed` (`{gitStatus, path}`), `broken` (dead patterns at target), `repoBroken` (dead cross-repo sources), `sections` (`{heading, affected}`), `notes`, `directive` |
| `mechanical` | Adapter-generated map — regenerate with `kaut map`, never hand-rewrite | `directive` |
| `wrong-repo-anchor` | `derived_from_commit` is not a commit of the anchor repo at all (harvest error) — re-derive fully | `notes`, `directive` |
| `off-main-anchor` | The anchor commit exists but is not on the main line (branch-anchored harvest) — re-derive fully | `notes`, `directive` |
| `invalid` | The doc fails the contract | `errors` |

The `directive` is a stable one-sentence re-derivation instruction (read sources AT the
target ref, set `derived_from_commit` to it, land via the write gate). Read-only; no lock,
no journal.

---

### `kaut_touched`

The change-site sensor: given repo-relative files the session edited, name every doc whose
source bindings (doc-level **or** section-level) cover them — the docs the session owes an
update (agent layer) or a draft (owner layer) before closing.

| Parameter | Type | Required | Meaning |
|---|---|---|---|
| `files` | string[] | yes (non-empty) | Repo-relative paths, as git prints them |

**Returns** (mirrors `kaut touched --json`): an array of
`{ "id": "<doc id>", "matched": [<the touched files that doc binds>] }` — empty array when
no doc binds the files. Pure read; no lock, no journal.

---

### `kaut_write`

Land an **agent-tier** doc update through the write gate. The complete updated doc
(frontmatter + body) replaces `<store>/<id>.md` and is validated, indexed, and committed
through the engine chokepoint (`kaut index`).

| Parameter | Type | Required | Meaning |
|---|---|---|---|
| `id` | string | yes | Doc id, e.g. `runbook/local-debug` |
| `content` | string | yes | The COMPLETE doc: frontmatter + body |

Semantics:

- The content is validated against the doc contract **before** anything touches the store
  (`invalid doc (nothing written): …` on failure) — the CLI's `index` would otherwise land
  an invalid doc with a report but exit 0, which must not pass for success on this surface.
- Owner-gated layers and **novel ids** are refused by the gate (SCHEMA §24); the error says
  so explicitly and directs the caller to `kaut_draft`. The refused file is rolled back
  (§1) — the store is never left dirty.
- Set `derived_from_commit` to the tracked main tip — `kaut_refresh` names it.
- The Tier-A discipline the description encodes: an agent-tier write requires this session
  to have **verified the fact** (runtime/code confirmation). The engine cannot prove that —
  it is honored by discipline, not enforced by the gate (SCHEMA §24).

**Returns**: `landed <id> through the write gate` plus the index summary line
(`index: N docs, …, committed`).

---

### `kaut_draft`

Queue a COMPLETE updated doc for asynchronous owner review — the path for owner-gated
layers (`decisions`/`domains`/`contracts`/`flows` under a typical policy) and novel ids.

| Parameter | Type | Required | Meaning |
|---|---|---|---|
| `id` | string | yes | Doc id the draft updates or creates |
| `content` | string | yes | The COMPLETE doc: frontmatter + body |

The queue door validates the contract AND the anchor: a `derived_from_commit` that is not a
commit of the anchor repo (wrong-repo anchor) or not on the main line (branch anchor) is
refused on the spot. The draft lands in `<store>/.drafts/<id>.md`, committed durably through
the ordinary chokepoint — but **never served to readers**; a lookup of the target doc only
shows a one-line "pending draft awaits review" note. On refusal the draft file is rolled
back (§1).

**Returns**: `draft queued: <id> — owner lands it via "kaut review --approve <id>"`. The
owner's `kaut review` (list / diff / approve / reject in batches) is a CLI-only verb — not
exposed here, by design.

---

### `kaut_status`

Store health overview — what rots and what awaits the owner.

Parameters: only the common `repo`.

**Returns**:

```json
{
    "verdicts": [ { "id", "verdict", "affected", "notes" }, … ],
    "pendingDrafts": [ { "id", "kind": "update" | "new" }, … ],
    "doctor": "<the doctor summary line, e.g. 'doctor: healthy'>",
    "engine": { "version": "<engine version>", "commit": "<short sha>" }
}
```

`verdicts` is the full `kaut stale --json` output (per-doc freshness; a doc with an
uncommitted store edit reports `tampered`; an invalid doc reports `verdict: null` with
`errors`). `pendingDrafts` is the draft queue as `kaut review --json` reports it.

## 4. Environment

| Variable | Meaning |
|---|---|
| `KAUT_ENGINE` | The engine checkout location — used by launchers/wrappers that need to find the engine; the server itself already knows where it lives |
| `KAUT_HOME` | One-off override of the knowledge-data home. Normally unnecessary: the engine resolves its data home by itself via the `kaut home` redirect (`~/.kaut/config.json`), so there is nothing to export and nothing for an orchestrator to pass. When set, it outranks the redirect |

The server passes its environment through to every spawned CLI call, so a `KAUT_HOME` set on
the server process applies uniformly.

## 5. Protocol notes

- **Transport**: newline-delimited JSON-RPC 2.0 over stdio (one JSON object per line).
  Lines are capped at 32 MB; an over-long line is answered with a parse error (`-32700`)
  rather than buffered without bound.
- **`initialize`** always answers `protocolVersion: "2025-06-18"` — the version this server
  actually implements, never an echo of the client's ask (echoing would claim features,
  e.g. batching, the server lacks). Capabilities: `{ "tools": {} }`. `serverInfo.version`
  is the engine version; the title carries the engine's short commit.
- **Batch arrays are rejected**: the 2025-06-18 protocol has no batching, so an array
  request is answered honestly with `-32600 "batching not supported"` instead of silently
  dropped (a batching client would hang forever on silence).
- **Notifications get no response** — not even errors (JSON-RPC semantics). The expected
  notifications (`initialized`, `cancelled`) are ignored.
- **Tool errors come back as results with `isError: true`** (MCP convention) — a failed
  lookup or a refused write is a tool-level outcome; the protocol layer stays healthy.
  Protocol-level errors are reserved for an unknown tool (`-32602`), an unknown method
  (`-32601`), a parse failure (`-32700`), and internal faults (`-32603`).
- **`ping`** is supported (empty result).
- The server exits cleanly when stdin closes.
