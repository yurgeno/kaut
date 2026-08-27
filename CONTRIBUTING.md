# Contributing to KAUT

Thanks for looking under the hood. This file covers the dev setup and the few rules
that keep the engine what it is.

## Dev setup

```bash
git clone <your fork or the canonical repo>
cd kaut
node --test        # that's it — no install step
```

There is **no `npm install`** — the engine has zero dependencies, runtime *and* dev.
Node ≥ 20 is required (development and verification happen on 24). Linux and macOS are
the supported platforms. Every test suite builds its own sandbox (temp stores,
throwaway git repos), so the suite runs from any checkout and leaves nothing behind.

## Running tests

Run the bare `node --test` from the repository root — do **not** pass the test
directory as an argument (on newer Node that form fails to resolve the suite). The
suite is currently **213 tests**, all on `node:test`, and it stays green: a PR that
turns any of them red is not ready.

## Ground rules

- **Zero runtime dependencies is a hard law of the engine, not an accident.** The CLI
  (`kaut.mjs`), the library (`lib/`) and the MCP server (`mcp.mjs`) run on plain Node.
  A PR that adds a runtime dependency needs an exceptional case; "convenient" is not one.
- **Match the existing idiom.** Small plain modules, explicit data flow, and comments
  only where the code cannot show the *why* on its own — invariants, err-toward-stale
  decisions, and boundary notes are exactly what comments are for; restating the code
  is not.
- **Behavior changes come with tests that pin the new behavior.** If the change alters
  what a verdict says, what the gate refuses, or what a command prints, a test must
  fail without the change and pass with it.
- **Docs update in the same change as the behavior they describe** (the
  docs-with-change rule). `README.md`, `docs/HANDBOOK.md`, `docs/OPERATIONS.md` and
  `SCHEMA.md` must never lag a landed change — a PR that changes behavior but not the
  docs describing it is incomplete.
- **Commit messages in English**, stating the user-visible effect.

## Security-sensitive areas

Some parts of the engine carry a security property, not just a behavior. Changes there
get extra scrutiny, and must include tests **proving the property still holds**:

- **The write gate and layered grants** — owner-gated layers and novel docs must keep
  queuing as drafts; nothing may land through the commit chokepoint without the tier
  the policy grants it.
- **Tamper containment** — a doc file edited outside the pipeline (uncommitted in the
  store's own git) must stay **withheld entirely** from readers until restored or
  properly re-committed.
- **Freshness verdicts** — the iron rule is *err toward "stale"*: no change may create
  a path where an unverifiable doc is served as fresh.
- **The MCP surface** — the owner-run escapes (`review --approve`, `index --approve`)
  are deliberately not exposed over MCP, and a refused write must roll back cleanly.

If you found a way *around* any of these, that is a vulnerability — report it privately
per [SECURITY.md](SECURITY.md) instead of opening a PR.

## Where design discussions happen

Open an issue first for anything beyond a straightforward fix — new verbs, verdict
semantics, schema changes, gate behavior. Design gets agreed in the issue; the PR then
implements the agreed shape. This keeps PRs small and reviewable.

## License

KAUT is Apache-2.0. By submitting a contribution you agree that it is licensed under
the same terms (see [LICENSE](LICENSE) and [NOTICE](NOTICE)), and that you have the
right to submit it — the substance of the Developer Certificate of Origin. A
`Signed-off-by` line is welcome but not required.

## Reporting

Bugs and feature requests: open an issue. Security issues: privately, per
[SECURITY.md](SECURITY.md). General contact: <yuriy.orlov@undertrust.dev>.
