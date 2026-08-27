# Changelog

## 0.8.1 — 2026-08-27

- Fix: `setup` / `home` no longer rewrite the operator's global data-home redirect when
  env `KAUT_HOME` is set — an env-isolated run (tests, CI, one-off overrides) previously
  persisted a redirect it then ignored, silently repointing the durable config. Now the
  redirect write is skipped with an honest message; stores land where the environment
  actually resolves them.
- `okf export`: `verified.by` is always the operator's identity — store commits are
  authored under the engine's git identity, so the commit author is deliberately ignored
  when reconstructing the human verification events.
- Docs: stale suite counts and the docs index brought current; `setup` added to the
  README command block.
- Suite: 211 → 213 tests.

## 0.8.0 — 2026-08-27

OKF v0.2 conformance — KAUT is an implementation of the vendor-neutral
[Open Knowledge Format](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md).

- `type:` is now stamped on every doc the engine writes (injected at the single
  serialization chokepoint; == the layer, validated). Legacy docs still read fine
  (back-derived from the path).
- New verb `kaut okf`:
  - `okf check` — store-as-OKF-bundle conformance report (exit 0 = conformant);
  - `okf stamp` — backfills `type:` on legacy docs through the ordinary write gate
    (`--approve` for owner-tier layers); idempotent;
  - `okf export --out <dir>` — projects the store's committed HEAD into a fully
    idiomatic OKF v0.2 bundle: OKF-shaped `sources` entries, `generated: {by, at}`
    (actor convention, doc's last store commit), `verified:` events recovered from
    owner-gate approvals in store history (`by: human:<owner>` — the OKF
    human-reviewed tier), bundle-root `index.md` with `okf_version: "0.2"`, `log.md`
    from store history; all KAUT-native keys ride along as OKF-protected extension
    keys; bodies verbatim. Refuses a non-empty target without `--force`.
- SCHEMA: the OKF section rewritten against v0.2 (two conformance surfaces, the full
  field mapping, one disclosed deviation: the native `sources` key keeps its typed-string
  shape in place — idiomatic shape is produced on export).
- Suite: 204 → 211 tests.

## 0.7.0 — 2026-08-27

- Stack adapters + auto-detection: bootstrap now detects the repo's stack and seeds
  `map.collectors` (existing configs untouched). New collectors: `springmap`
  (Java/Kotlin Spring route table, nested build roots supported), `jvmgraph`
  (Gradle/Maven module graph incl. single-module builds), `nextroutes` (Next.js
  App+Pages file routing), `httproutes` (Express/Nest/FastAPI/Flask lexical routes),
  `phproutes` (Laravel/Symfony routes), `sqlmigrations` (Flyway-style inventory).
  Every collector skips gracefully when its stack marker is absent.
- Docs: the supported-stacks table and the explicit platform statement (developed and
  tested on macOS and Linux; Windows not supported).

## 0.6.0 — 2026-08-27

- `kaut backup` / `kaut restore`: the whole data home (stores with their git history, the
  workspace registry, the setup record) packed into a dated, versioned, restorable
  `.tar.gz` under `<data>/backups/` — hand-rolled ustar + node:zlib, zero dependencies,
  readable by any standard tar tool. Restore never overwrites existing data without
  `--force`; `restore` with no argument lists the available archives.

## 0.5.0 — 2026-08-27

- `kaut setup`: the guided install. Clone the engine next to the repositories it serves,
  answer three questions (knowledge-data folder → persisted redirect; which sibling repos
  to serve, scanned automatically; bootstrap now or later) and setup finishes with the two
  wiring steps printed (MCP registration + the agent knowledge contract). Every question
  has a flag (`--data/--repos/--scan/--bootstrap/--no-bootstrap/--yes`) for scripted runs.
  Bootstrap stays strictly additive: existing store data is actualized, never wiped.
- `kaut home <dir>`: persistent knowledge-data home redirect (the engine owns its data
  location; callers and the MCP server resolve it with no env involved).
- `map`: the route collector skips itself when the default routes file is absent (stack
  mismatch, not an error) — the remaining collectors still run.
- docs: agent wiring guide (docs/AGENT-INTEGRATION.md), MCP reference (docs/MCP.md),
  community files, CI workflow, social preview.

## 0.4.0 — 2026-08-26

**First public release.**

- `kaut home <dir>`: a persistent knowledge-data home redirect (`~/.kaut/config.json`) — the engine owns its data location; callers pass nothing.
- `lookup` one-call read surface with freshness verdicts (merge-base-anchored, err-toward-stale;
  `healthy`/`stale`/`broken`/`disputed`/`branch-advisory`), trust tiers (T0–T4), and the
  `altitude` coverage band (`landscape`/`component`/`endpoint`; landscape docs emit a
  confirm-in-code directive).
- Tamper containment: a doc edited outside the pipeline is `tampered` — withheld from every
  read path, with heal instructions; `doctor` fails on a dirty store.
- Freshness correctness: ahead-of-anchor-on-main-line is FRESH, not stale (only genuine
  divergence errs toward stale).
- Multi-repo workspace: `workspace init|list` from a conductor manifest; registry under
  `<home>/workspaces/`; per-member store provisioning; SYSTEM store anchored to a launcher
  repo (`project.anchorRepo`); cross-repo `repo:` sources; compose-map collector.
- Layered write gate (`writePolicy`) enforced at the commit chokepoint; novel doc ids are
  owner-gated (creation distinction); `--approve` is the owner-run escape;
  open-until-configured.
- Drafts & review: owner-gated updates queue as contract-validated drafts
  (`draft`, with anchor triage at the queue door) for asynchronous batch review
  (`review --approve/--reject`).
- Maintenance loop: `refresh` (per-doc re-derivation delta bundles, read-only) and
  `touched` (change-site sensor: which docs bind the files a session edited).
- Telemetry: `digest` (journal aggregation across workspace stores) and `note`
  (`op:outcome` value signal: trusted/confirmed/insufficient/stale-misled).
- OKF conformance: optional `type` key (== layer, back-derived), stamped into `map/*`;
  KAUT's provenance fields ride as protected extensions.
- MCP server (`mcp.mjs`): zero-dependency stdio JSON-RPC exposing the session verbs
  (`kaut_lookup`/`note`/`refresh`/`touched`/`write`/`draft`/`status`); write rollback on
  refusal; owner-run escapes deliberately not exposed.
- Security hardening: `core.quotepath=false` everywhere, `--no-renames` in tamper
  detection, grant pre-flight before INDEX rewrite, dirty-catalog withhold, doc-id
  confinement at both CLI and MCP boundaries.
- Packaging: LICENSE (Apache-2.0), NOTICE, CITATION.cff, package.json, CHANGELOG, `--help`.

## 0.3.0 — 2026-06-12 (pre-release, internal)

- Workspace thin slice: registry, per-member stores, SYSTEM store anchored to a launcher
  repo, compose-map collector.

## 0.2.x — 2026-06-11..12 (pre-release, internal)

- `lookup` read surface with freshness verdicts and trust tiers; tamper containment.

## 0.1.0 — 2026-06-10 (pre-release, internal)

- Store skeleton + doc formats (frontmatter contract, sources grammar, layers);
  `bootstrap`, `index`, `doctor`.
