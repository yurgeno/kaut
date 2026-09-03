# KAUT Operations Reference

Operator depth for the KAUT engine: where things live on disk, how resolution works, the
integrity mechanics, and the engine's internal layout. For the product narrative, quickstart,
and the full command table see the repo [README.md](../README.md); for how it all works and
why, [HANDBOOK.md](HANDBOOK.md); for the normative data contract, [SCHEMA.md](../SCHEMA.md).

## Where things live

- **Store** (per project): `~/.kaut/<basename>--<hash8>` — derived from the normalized origin
  remote URL, so clones and worktrees of one project share one store. Own private git inside
  (author `KAUT <kaut@local>`), never pushed anywhere.
- **Pointer**: `<repo>/.kaut.json` (absolute paths), ignored via `.git/info/exclude` — the
  project repository itself is never modified. Losing the pointer is harmless (derivation
  resolves the same store).
- **Store config**: `<store>/kaut.config.json` (created by bootstrap; reference:
  [HANDBOOK.md §15](HANDBOOK.md#15-configuration-reference)).
- **Resolution order**: `KAUT_ROOT` env (`KAUT_ENGINE` analogously) → pointer → derivation.
- **Workspace**: registries in `~/.kaut/workspaces/` (SCHEMA §21); a SYSTEM store
  may anchor its freshness to a different repo via config `project.anchorRepo` (SCHEMA §18);
  `repo:<name>:file:<path>` sources are existence-only cross-repo bindings (SCHEMA §17).
  The data home resolves as: `KAUT_HOME` env → the `dataRoot` redirect in
  `~/.kaut/config.json` (written by `kaut home <dir>` — the engine's own install step) →
  `~/.kaut` itself. `KAUT_WORKSPACES_DIR` overrides just the registry directory. The engine
  checkout stays anchored at `~/.kaut/engine` (or wherever the caller invokes it) — only
  the DATA follows the redirect.
- **Backups**: `kaut backup` → `<data>/backups/kaut-backup-<YYYYMMDD-HHMMSS>-v<engine>.tar.gz`
  (plain ustar+gzip, zero deps, tar-readable); `kaut restore [latest|<file>]` refuses to
  overwrite existing data without `--force`. The backups folder is excluded from archives.
- **Journal**: `<store>/journal.jsonl` is append-only untracked telemetry and grows without
  bound; it is safe to truncate old lines manually (it is never knowledge, and `digest`
  simply sees a shorter history).

## Integrity mechanics

**Tamper containment:** every byte `lookup` serves must come from a KAUT commit in
the store's own git. A doc edited, added, or deleted outside the pipeline (uncommitted in the
store) is `tampered`: its content is withheld entirely — the file is not even parsed — and the
render carries only heal instructions (`git checkout -- <file>` to discard · `kaut index` to
accept with provenance · `kaut map` for regenerable maps). `doctor` FAILs on a dirty store
(`store-clean`) and WARNs on foreign commit authors (`store-authors`). Docs are injected
into agent context, so an unprovenanced edit is an injection channel: withholding beats serving.

**Write gate:** when a workspace registry declares a `writePolicy`, every write funnels
through the commit chokepoint: agent-tier layers land directly (`index`), owner-gated layers
and NOVEL doc ids are refused and go through `draft` → owner `review --approve`. With no
registry/policy the gate is inert (open-until-configured).

## Day-to-day

The reading core: `lookup` (the one-call read entry an agent uses instead of re-grepping),
`stale` (merge-base-anchored freshness verdicts), and `map` (deterministic L0 route table +
package graph + compose map, regenerated on demand). Still no LLM in the engine and no
automated *knowledge* writing — facts in `domains/` and `decisions/` are written by sessions
and land through the write gate; only the T0 `map/` docs and `journal.jsonl` are
machine-generated. The contract every fact follows is [SCHEMA.md](../SCHEMA.md).

Freshness is anchored to `merge-base(HEAD, <main>)`, so a doc's stored verdict depends only on
what reached the shared main line — switching branches never flaps it. A branch's own edits
surface as an **ephemeral** advisory computed at read time, never written down.

## Uninstall

```bash
rm -rf ~/.kaut/<project-id>         # the store (its git history goes with it)
rm <repo>/.kaut.json                # the pointer
# remove the ".kaut.json" line from <repo>/.git/info/exclude
```

The project repository needs no cleanup — it was never modified.

## Development

```bash
cd <engine> && node --test          # 225 tests, zero deps (node:test)
```

Run the bare `node --test` — do **not** pass the test directory as an argument (on Node ≥ 24
that form fails to resolve the suite).

Layout: `kaut.mjs` (CLI) · `mcp.mjs` (MCP stdio server) · `lib/discover.mjs` (resolution
chain + config fallback) · `lib/frontmatter.mjs` (restricted-YAML subset) · `lib/sources.mjs`
(typed sources) · `lib/sections.mjs` (section/binding parser) · `lib/glob.mjs` (zero-dep
`**`/`*`/`?` matcher) · `lib/stale.mjs` (anchor + verdicts) · `lib/refresh.mjs` (re-derivation
deltas) · `lib/altitude.mjs` (coverage band) · `lib/lookup.mjs` (block renderer) ·
`lib/journal.mjs` (telemetry) · `lib/digest.mjs` (journal aggregation) · `lib/routemap.mjs` +
`lib/pkggraph.mjs` + `lib/composemap.mjs` + `lib/springmap.mjs` + `lib/jvmgraph.mjs` + `lib/pymap.mjs` + `lib/nextroutes.mjs` + `lib/httproutes.mjs` + `lib/phproutes.mjs` + `lib/sqlmigrations.mjs` (L0 adapters; `lib/stackdetect.mjs` picks them at bootstrap) · `lib/registry.mjs` (workspace
registry reader) · `lib/workspace.mjs` (workspace planning) · `lib/grants.mjs` (layered write
gate) · `lib/drafts.mjs` (draft queue) · `lib/lock.mjs` (mkdir lock) · `lib/gitstore.mjs`
(store git + commit chokepoint) · `lib/indexgen.mjs` (INDEX renderer + doc validation).

Versioning: `VERSION` file (mirrored in `package.json`); facts record provenance as
`<collector>@<engine-version>` (`route-map@0.9.0`, `pkg-graph@0.9.0`, `py-map@0.9.0`, `http-routes@0.9.0`, `sql-migrations@0.9.0` for the L0 maps).
Data-contract changes must be additive (see [SCHEMA.md](../SCHEMA.md) preamble).
