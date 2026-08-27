# KAUT — Knowledge Actualization Under Trust

> **Makes legacy codebases AI-native.** KAUT is self-maintaining, AI-first documentation for
> your project — a knowledge layer that makes undocumented, weak-context code legible to AI
> agents. Not a memory of conversations — a knowledge base about the system itself: what it
> does, how it is structured, and why. It turns what agents learn while working into living
> documentation — so no session starts from zero.

Zero-dependency Node.js (≥ 20, developed on 24), macOS/Linux, Apache-2.0.

**A complete, standalone product.** One `git clone` is the whole install; point your harness
at the bundled MCP server (or call the CLI from any skill/prompt) and it works — no
orchestrator, no framework, no services, no accounts, nothing else to deploy. It composes
with the sibling [TAUT](https://github.com/yurgeno/taut) orchestration framework (TAUT drives
agents, KAUT is what they know) — but that integration is optional, not a dependency.

**Status: v0.4.0 — the full loop is live.** Reading: `lookup` (one-call ready answer) with
freshness verdicts (merge-base-anchored, never crying "fresh" when unsure), trust tiers, and
the `altitude` coverage band; tamper containment withholds anything edited outside the
pipeline. Multi-repo: workspace registry, per-member stores, one system store anchored to a
launcher repo. Writing: the layered write gate (agent-tier updates land directly; owner-gated
layers and novel docs queue as **drafts** for asynchronous review). Maintenance: `refresh`
(re-derivation delta bundles), `touched` (change-site sensor), `digest`/`note` (usage and
outcome telemetry). Any MCP-capable harness plugs in via the bundled MCP server. What is
live in detail: [docs/HANDBOOK.md §16](docs/HANDBOOK.md#16-status--roadmap).

---

## The problem it solves

Every new AI session starts with amnesia: the agent re-explores your project, asks the same
questions again, and — worst of all — keeps making the most expensive kind of mistake:
**code that compiles and passes tests, but quietly breaks a business rule it had no way of
knowing about.**

The "why" of a project is usually written nowhere. KAUT gives it a place to live — and keeps
it alive.

This hurts most on **legacy code**: years of undocumented decisions, no original authors
around, business rules visible only as side effects. That is precisely where AI coding tools
underperform today — and precisely the codebase KAUT is built for. KAUT is the first step of
a larger goal: **making legacy codebases AI-native** — structured so that agents can work on
them safely and cheaply.

## What KAUT is — and is not

Three familiar categories look similar from a distance. KAUT is none of them — and the
differences are exactly where the value is.

| | What it stores | How it stays true | What happens when the code changes |
|---|---|---|---|
| **Agent memory** | conversations, preferences | it doesn't — episodic recall is unverifiable | nothing; yesterday's recollection is served as-is |
| **RAG / embeddings** | chunks of whatever text exists | it doesn't — retrieval has no freshness or provenance contract | stale chunks keep ranking high, served with full confidence |
| **A wiki / auto-generated docs** | prose someone once wrote (or an LLM once guessed) | manual diligence | it rots silently; nothing warns the reader |
| **KAUT** | distilled, curated facts, each bound to its sources and anchored to a commit | freshness is **computed from git** on every read; a gated write path keeps humans in charge of judgment-tier knowledge | the verdict flips to `stale` automatically, and the answer says "re-check this" instead of pretending |

**Not another memory system.** Memory answers *"what did we talk about, what does this user
prefer?"* — personal, episodic, unverifiable. KAUT answers *"how does this project work, and
why?"* — documentation: organized by domain, source-bound, freshness-checked, trust-labeled,
and readable by any agent **and by humans**. Personal notes never enter KAUT; project
knowledge never stays trapped in one agent's memory. That boundary is built into the write
path.

**Not RAG.** Retrieval-augmented generation indexes whatever text happens to exist and
serves the best-matching chunks — with no idea whether they are still true. KAUT stores the
*opposite* selection: only knowledge that is **expensive to re-derive and not cheaply visible
in the code** (the storage litmus), distilled into short docs a model reads whole — no
embeddings, no ranking, no chunk soup. And every doc carries a machine-checked freshness
verdict: anchored to the commit it was derived from, diffed against the tracked main branch
on every read, **erring toward stale** when git cannot prove otherwise. Run RAG over your
code if you like — KAUT is for what the code does *not* say: the why, the cross-cutting
invariants, the tribal knowledge.

**Not an LLM wiki.** Auto-generated documentation is plausible text, unverified at birth and
abandoned at first commit. A KAUT doc cannot exist without typed source bindings and an
anchor commit — and cannot *stay* wrong silently, because the sources are diffed on every
read. The write path is the other half: mechanical layers regenerate automatically, agents
may land operational facts they verified in-session, but judgment-tier knowledge (decisions,
domain semantics, contracts) only enters through a human-approved gate — updates queue as
drafts you review in batch. A wiki decays by default; KAUT's default is to confess.

## Principles

1. **Source-bound, commit-anchored.** Every fact names the files it came from and the commit
   it was derived at. No source, no doc — the contract is validated at the door.
2. **Err toward stale.** Freshness is a pure git computation (merge-base against the tracked
   main branch). When git cannot prove a doc is current, the verdict says so. KAUT never
   cries "fresh" when unsure — a false "stale" costs a re-check; a false "fresh" ships a bug.
3. **Knowledge informs; it never authorizes.** A healthy verdict is permission to skip
   re-derivation, not permission to act. Verdicts route *trust*: healthy + precise = usable
   as-is; stale / broken / coarse-altitude = confirm in code first.
4. **Serve nothing you can't vouch for.** The store is read by AI agents, so an out-of-pipeline
   edit is an injection channel, not a convenience. Anything not byte-identical to the last
   pipeline commit is withheld entirely (`tampered`) until restored or legitimately landed.
5. **Humans own judgment; agents own mechanics.** The layered write gate: maps regenerate
   freely, verified operational facts land at agent tier, and decision/domain/contract
   knowledge waits in a draft queue for the owner's one-keystroke review.
6. **Repair where it's cheapest.** Freshness decay is fought structurally, not heroically:
   the change site (`touched` names the docs a code change owes), the read site (a stale
   verdict arrives with a `refresh` delta bundle — exactly what changed, against what to
   re-derive), and honest telemetry (`digest`) to see whether upkeep keeps pace.
7. **Local-first, zero-dependency, repo-untouched.** One clone, no install step, no daemon,
   no cloud; the knowledge store lives outside your repository, and freshness checks cost
   git comparisons — not model calls.

## What KAUT does

- **One known place to look.** The agent checks KAUT before re-exploring your code. Either the
  answer is there, or KAUT notes the gap so it gets filled later.
- **Knowledge collects itself.** After a task is done, the useful things the agent just learned
  are condensed into the base — a byproduct of work already paid for, not a separate
  documentation project.
- **It never lies confidently.** Every stored fact stays tied to the code it came from. When that
  code changes, the fact is automatically flagged as possibly outdated. When in doubt, KAUT says
  "re-check this" instead of pretending everything is fresh.
- **It refuses to serve what it can't vouch for.** The knowledge base is read by AI agents, so
  a file edited behind KAUT's back (outside its own version control) is a potential injection
  channel. Such content is withheld entirely until it is restored or properly re-committed —
  every answer the agent sees comes from a provenance-tracked commit.
- **You stay the judge.** Owner-gated layers and novel docs never land without your approval:
  updates queue as **drafts** (`kaut draft`), and you land or drop the whole batch in one
  sitting (`kaut review`). You don't have to be present when the agent finishes.
- **Your repository is never touched.** All knowledge lives in a separate folder outside the
  project. Your git history, branches, and teammates never see it.
- **Any agent can plug in.** Besides the CLI, KAUT ships an MCP server (`node
  <engine>/mcp.mjs`, zero dependencies) — the same lookups, freshness verdicts, and gated
  writes as MCP tools, for any MCP-capable harness or orchestrator. One server handles a
  whole multi-repo workspace (each call names its repo).

## Quickstart

The supported install is a git clone. The canonical location is `~/.kaut/engine`, but any
path works — the engine is invoked as `node <engine>/kaut.mjs` and resolves everything else
itself (an orchestration framework consuming KAUT, e.g. TAUT, records the engine location in
its own configuration). There is no `npm install` step — the engine has zero dependencies.

Optional install step — choose where knowledge lives (stores + workspace registry).
Default is `~/.kaut`; to keep the data in a dedicated folder (backups, visibility, its own
lifecycle) record a redirect once:

```bash
node <engine>/kaut.mjs home ~/kaut-data
```

The redirect persists at `~/.kaut/config.json`, so every later caller — CLI or the MCP
server — resolves the data location by itself; nothing to export, nothing for an
orchestrator to pass. `kaut home` (no argument) shows the current home and where it came
from; the `KAUT_HOME` env var still outranks the redirect for one-off overrides.

From your project directory run

```bash
node <engine>/kaut.mjs bootstrap
```

once — it creates the knowledge store outside your repo and verifies itself (`doctor`). Then
generate the project map (route table + package graph):

```bash
node <engine>/kaut.mjs map
```

Note: the default `map` globs are Vue/monorepo-conventional (`src/router/routes.ts`,
`packages/*`); on other stacks the route collector is skipped with a "routes file not found" note and the rest still run. Point
`map.routesFile`/`map.packagesDir` at your stack's files in the store config, trim
`map.collectors`, or skip `map` entirely.

Then: **work as usual.** That is the entire setup. The agent looks things up on its own
(`kaut lookup` from the CLI, or the `kaut_*` tools over MCP — `node <engine>/mcp.mjs`); if
you ever want to browse, `node <engine>/kaut.mjs lookup` prints the catalog of topics.

## Daily use — there is none

KAUT is designed to be invisible. You will notice it in exactly three moments:

- **On your command** — tell the agent to save what it just learned ("persist this to KAUT"):
  it filters the session's findings through the litmus test, writes
  them with proper source bindings, and commits to the store's git. Owner-gated knowledge
  still stops at the draft queue for your review.
- **When drafts pile up** — `kaut review` lists what awaits you; approve or reject the batch
  in one sitting (`doctor` also warns while a queue is pending).
- **Occasionally** the agent asks a question only a human can answer ("is this rule intentional,
  or an accident?"). Your answer becomes the most valuable kind of knowledge in the base.

Everything else — looking things up, checking freshness, rebuilding the map — happens
automatically and silently.

## Commands

Run from anywhere inside a project git repository:

```bash
node <engine>/kaut.mjs bootstrap     # create/repair the project's knowledge store (idempotent)
node <engine>/kaut.mjs index         # regenerate INDEX.md (under lock; auto-commits changes)
node <engine>/kaut.mjs doctor        # integrity checks; exit 0 = healthy
node <engine>/kaut.mjs home [<dir>]  # show or set the knowledge-data home (redirect at ~/.kaut/config.json)
node <engine>/kaut.mjs paths         # print resolved {projectId, root, engine, repo, mainBranch, source}
# reading core:
node <engine>/kaut.mjs lookup [<id>] # one-call ready block; no id = catalog; unknown id = miss (exit 0)
node <engine>/kaut.mjs stale [<id>…] # freshness verdicts for all/selected docs (read-path, no lock)
node <engine>/kaut.mjs map           # regenerate L0 maps per config map.collectors + commit
# maintenance loop:
node <engine>/kaut.mjs refresh [<id>…]        # per-doc re-derivation delta bundles (read-only)
node <engine>/kaut.mjs draft <id>             # queue a finished doc update for async owner review
node <engine>/kaut.mjs review [<id>…]         # owner side: list / diff / --approve / --reject
node <engine>/kaut.mjs touched <file>…        # which docs bind the given changed files
# telemetry:
node <engine>/kaut.mjs note <topic> <result>  # record an in-session outcome (trusted|confirmed|insufficient|stale-misled)
node <engine>/kaut.mjs digest [--since <ISO>] # aggregate journal telemetry across workspace stores
# workspace (multi-repo):
node <engine>/kaut.mjs workspace init --manifest <conductor>/manifest.json
                                     # registry + member stores + ONE system store anchored to the launcher
node <engine>/kaut.mjs workspace list
```

MCP server: `node <engine>/mcp.mjs` — a zero-dependency stdio JSON-RPC server exposing the
session verbs as MCP tools (`kaut_lookup`, `kaut_note`, `kaut_refresh`, `kaut_touched`,
`kaut_write`, `kaut_draft`, `kaut_status`). Every tool takes an optional `repo` argument, so
one server serves a whole multi-repo workspace. The owner-run escapes (`review --approve`,
`index --approve`) are deliberately not exposed over MCP.

Flags: `--dry-run` (print actions without acting) · `--json` (machine output for
`stale|lookup|refresh|review|touched|digest`) · `--quiet` · `--approve` / `--reject`
(owner-run) · `--note <text>` (`note`, `review --reject`) · `--manifest <path>`
(`workspace init`) · `--workspace <name>` (`doctor`/`stale`/`digest` across a workspace) ·
`--since <ISO-date>` (`digest`) · `--help`/`-h` (usage, exit 0).

Exit codes: `0` ok · `1` validation/doctor failure · `2` store busy (lock held) · `3` environment
missing (not a git repo / store not bootstrapped).

`lookup` and `stale` are read-path — they take no lock and only append a line to
`journal.jsonl` (usage telemetry, untracked). A freshness verdict is **data, not an error**:
`stale` exits 0 even when docs are stale. Verdict line, at most one, by priority
`tampered > disputed > broken > stale > branch-advisory`; a healthy doc renders clean.

Operational depth — store layout on disk, resolution order, tamper containment and the write
gate in detail, uninstall, engine internals: [docs/OPERATIONS.md](docs/OPERATIONS.md).

## Configuration

One file: `kaut.config.json` in the store (created by bootstrap, sensible defaults). Most
people only ever touch the `map` block (collector list and file locations — see the
quickstart note above). The full reference of what the engine actually reads:
[docs/HANDBOOK.md §15](docs/HANDBOOK.md#15-configuration-reference).

## Is it actually helping?

KAUT is built to keep itself honest:

- It maintains a **usage journal** per store (`journal.jsonl`): every lookup with its verdict,
  every gated write, every recorded outcome. `kaut digest` aggregates it across a workspace
  into reach / self-maintenance / value-signal numbers.
- Sessions record how a doc actually fared (`kaut note <topic>
  trusted|confirmed|insufficient|stale-misled`) — the honor-system value signal that shows
  where knowledge saved work and where it misled.
- Benchmarking is done externally (run the same task with and without KAUT and compare);
  the engine deliberately ships no benchmark harness.

The journal is append-only untracked telemetry and grows without bound; it is safe to
truncate old lines manually (it is never knowledge, and `digest` simply sees a shorter
history).

## Tests

```bash
cd <engine> && node --test          # 162 tests, zero deps (node:test)
```

Run the bare `node --test` — do **not** pass the test directory as an argument (on Node ≥ 24
that form fails to resolve the suite).

## Uninstall

Delete the store directory (`~/.kaut/<project-id>`) and the pointer file
(`<repo>/.kaut.json`), and remove the `.kaut.json` line from `<repo>/.git/info/exclude`.
Your repository was never modified to begin with — there is nothing else to clean up.

## FAQ

**Is this just another agent memory system?**
No. Agent memory remembers conversations and preferences; KAUT is the project's
documentation — AI-first, source-bound, freshness-checked. The write path enforces the
boundary: project knowledge goes to KAUT, personal preferences go to the agent's own memory.

**Is this RAG?**
No. There are no embeddings, no chunking, no retrieval ranking. KAUT stores a small set of
distilled docs an agent reads whole, each with provenance and a git-computed freshness
verdict — and deliberately stores only what is *not* cheaply derivable from the code. RAG
over your codebase and KAUT answer different questions and coexist fine.

**Is this an auto-generated wiki?**
No. Nothing enters the store as unverified generated prose: every doc must carry typed
source bindings and a commit anchor, mechanical layers are regenerated (not hallucinated),
and judgment-tier knowledge passes a human-approved gate. And unlike a wiki, a KAUT doc
cannot rot silently — its sources are diffed on every read.

**Will it commit anything into my repository?**
No. At most one ignored pointer file. The knowledge store lives outside the repo.

**Does my team have to adopt it?**
No. KAUT is local-first: one developer installs it and benefits; nobody else is involved or
affected.

**What if a stored fact is wrong?**
Every fact carries its origin and a trust label; the agent treats low-trust facts skeptically and
verifies them against code. The store keeps full history, so bad entries can be traced and rolled
back.

**What does it cost to run?**
The first map build is the expensive part (minutes). Day-to-day upkeep is designed to cost
near-nothing: freshness checks are pure git comparisons — no AI calls involved.

## Learn more

- **The project wiki** — Getting Started, Connecting Your Project, Core Concepts, the
  Maintenance Loop, FAQ and Troubleshooting in guided form
- [docs/HANDBOOK.md](docs/HANDBOOK.md) — how it all works, in human language but in full detail
- [docs/OPERATIONS.md](docs/OPERATIONS.md) — operator reference: on-disk layout, resolution,
  tamper containment, write gate, engine internals
- [docs/MCP.md](docs/MCP.md) — the MCP server reference: registration, all 7 tools, protocol
- [SCHEMA.md](SCHEMA.md) — the normative data contract this engine implements
- [CHANGELOG.md](CHANGELOG.md) — release history
- [CONTRIBUTING.md](CONTRIBUTING.md) · [SECURITY.md](SECURITY.md) ·
  [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)

## License & citation

Apache-2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE). If you use KAUT or build on the
concepts it implements, please cite it via [CITATION.cff](CITATION.cff).

Contact: Yuriy Orlov <yuriy.orlov@undertrust.dev>
