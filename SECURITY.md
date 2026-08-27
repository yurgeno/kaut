# Security policy

KAUT's stores are **read by AI agents**: whatever the engine serves gets injected into
an agent's context and shapes its work. Content integrity is therefore the security
property, and the engine defends it mechanically — tamper containment withholds
anything edited outside the pipeline (an unprovenanced edit is a prompt-injection
channel, so it is not even parsed), the layered write gate keeps owner-tier knowledge
human-approved (owner-gated layers and novel docs queue as drafts and are never served
until reviewed), freshness verdicts err toward "stale" rather than ever claiming fresh
when unsure, and the MCP surface exposes only the session verbs — the owner-run
escapes (`review --approve`, `index --approve`) are deliberately not reachable over
MCP. Bugs in any of those are security bugs.

## Reporting a vulnerability

Report privately by email to **yuriy.orlov@undertrust.dev** — please do not open a
public issue for anything exploitable. Include what you did, what happened, and the
commit you saw it on. Expect an acknowledgement within a few days; this is a
solo-maintained project, so fixes land as fast as one person can verify them.

## What is in scope

- **Serving unreviewed content** — any way to get content in front of a reader
  (`lookup`, the MCP tools) that did not come from a provenance-tracked commit in the
  store's own git: bypassing tamper containment, getting a queued draft served before
  approval, or a refused MCP write leaving the store dirty instead of rolling back.
- **Write-gate bypass** — landing an owner-gated or novel doc through the commit
  chokepoint without the owner's `--approve`, or an agent-tier grant reaching a layer
  the policy does not give it.
- **Verdict suppression** — a path where a doc that should read `tampered`, `broken`,
  or `stale` is served clean, or where the engine claims fresh without being able to
  verify it.
- **Store-root escape** — a doc id, source pattern, or path that makes the engine
  read or write outside the store root (or outside the repo it resolved).
- **MCP surface escape** — reaching an owner verb, or any action beyond the declared
  tool set, through the MCP server.

## What is not

- **Store-commit authorship.** Tamper containment catches *uncommitted* edits — bytes
  that never went through the pipeline. It does not authenticate *who* made a store
  commit: a local attacker who can run git in the store can spoof authorship. The code
  itself documents this boundary; an attacker with local write access to the store or
  the engine checkout is game over by construction, and the design goal is to make
  interference *visible*, not to stop that attacker.
- **Bad knowledge honestly stored.** A wrong fact that entered through the pipeline
  with its trust label and sources is a quality problem, not a vulnerability — the
  trust tiers and freshness verdicts exist precisely so readers treat it accordingly.
- The harness's own model behavior.

## Supported versions

The tip of the default branch is the supported version. There is no backport policy;
update the engine checkout and re-run `doctor`.
