# Changelog

## 0.4.0 — 2026-08-26

**First public release.**

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
