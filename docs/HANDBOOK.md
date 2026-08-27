# KAUT Handbook

*The complete technical guide — written for humans.*

The repo [README.md](../README.md) tells you how to *use* KAUT; this handbook explains
**what it actually does and why it works**. It is written for a person, not an agent:
mechanisms and reasoning, no schemas or source code. The exact on-disk formats and read-time
semantics — the normative contract — live in [SCHEMA.md](../SCHEMA.md); operational depth in
[OPERATIONS.md](OPERATIONS.md).

**Status: describes the system as designed (v1.0, frozen 2026-06-10). What is actually built is
tracked per phase in [§16](#16-status--roadmap).** *(Docs home: `<engine>/docs/` — the engine
documents itself; it is not documented inside any consuming project.)*

---

## Contents

1. [The problem](#1-the-problem)
2. [The core idea: documentation as a cache](#2-the-core-idea-documentation-as-a-cache)
3. [Inside the knowledge store](#3-inside-the-knowledge-store)
4. [Anatomy of a fact](#4-anatomy-of-a-fact)
5. [Freshness — how KAUT knows a fact is outdated](#5-freshness--how-kaut-knows-a-fact-is-outdated)
6. [Trust — five levels of confidence](#6-trust--five-levels-of-confidence)
7. [The reading path: lookup](#7-the-reading-path-lookup)
8. [The writing path: distill](#8-the-writing-path-distill)
9. [Discipline: obligations and the post-task hook](#9-discipline-obligations-and-the-post-task-hook)
10. [Safety: knowledge never commands](#10-safety-knowledge-never-commands)
11. [The rigor dial: assurance levels](#11-the-rigor-dial-assurance-levels)
12. [Self-honesty: journal, benchmark, kill criterion](#12-self-honesty-journal-benchmark-kill-criterion)
13. [Health, degradation, rollback](#13-health-degradation-rollback)
14. [Updating KAUT itself safely](#14-updating-kaut-itself-safely)
15. [Configuration reference](#15-configuration-reference)
16. [Status & roadmap](#16-status--roadmap)
17. [Glossary](#17-glossary)

---

## 1. The problem

AI coding agents start every session from zero. They re-derive the project picture, re-ask
answered questions, and re-spend tokens on exploration already done yesterday. That is the
visible cost. The invisible, larger cost: **the project's intent — the "why" — exists only in
people's heads and in thousands of tickets.** Code answers "how does it work", never "what is it
for". So the agent's most expensive failure mode is a change that is formally correct (compiles,
passes tests, looks idiomatic) yet violates an unwritten business rule.

Classic documentation does not fix this. It is expensive to write, competes with real work for
maintenance, rots within months, and stale documentation is *worse* than none — it lies with
confidence. Corporate wikis are graveyards.

KAUT was designed under explicit constraints, which shaped every decision below:

- **Zero maintenance budget** — the system must keep itself current.
- **Single-developer adoption** — no team buy-in, no process changes, no PR pollution.
- **Cheap to run** — an expensive first harvest is acceptable; day-to-day upkeep must cost cents.
- **Honest** — it must measure its own usefulness and admit failure.
- **Removable** — clean uninstall, nothing left behind; eventually a portable "box" for any
  project.

### 1.1 Positioning: not another memory system

KAUT is easy to mistake for "cross-session agent memory" — a crowded category solving a
different problem. The distinction is fundamental and shapes the entire design:

| | Agent memory | KAUT |
|---|---|---|
| **Subject** | The *conversation*: episodes, user preferences | The *project*: structure, behavior, intent |
| **Organization** | Chronological, episodic | By domain: map, domain notes, decisions |
| **Verifiability** | Unverifiable recollections | Every fact source-bound, freshness-checked, trust-labeled |
| **Audience** | One agent | Any agent — and humans; it reads as documentation |
| **Lifetime** | Personal, decays silently | Versioned, auditable, rollback-able, transferable (seed) |

KAUT is **the project's documentation, written AI-first** — documentation that happens to
maintain itself. The boundary is enforced mechanically in the write path (§8): project
knowledge routes to KAUT; personal preferences route to the agent's own memory — never the
other way around.

## 2. The core idea: documentation as a cache

Documentation fails as a *library* (write everything up front, maintain it forever — nobody
does). KAUT treats it as a **cache over the codebase and the team's heads**:

| Cache concept | KAUT equivalent |
|---|---|
| Cache hit | The agent finds the answer in the store, skips re-exploration |
| Cache miss | The gap is logged and becomes an *obligation* to fill |
| Invalidation | Source code changed → fact flagged stale, mechanically, for free |
| Lazy fill | Knowledge accumulates where work actually happens — desire paths, not master plans |
| Regeneration | The map layer is rebuilt from code by scripts — never hand-written, never trusted to an LLM |

One rule decides what may be stored at all — the **litmus test**:

> *"If tomorrow's agent can get it from the code cheaply — don't store it."*

So KAUT stores what code cannot say: intent, business rules, constraints, decisions and their
reasons, tribal knowledge. Everything derivable from code is derived on demand instead — a
derived fact can be stale; a re-derived fact cannot.

## 3. Inside the knowledge store

```
~/.kaut/<project-id>/
├── .git/                ← the store's own private git (no remote, never pushed)
├── .gitignore           ← keeps locks and temp files out of store history
├── kaut.config.json    ← configuration
├── INDEX.md             ← catalog: topic → file → code anchor
├── map/                 ← L0: script-generated project map
├── domains/             ← L1: thin per-domain notes
├── decisions/           ← L3: the "why" — business rules, ticket-anchored decisions
└── obligations.jsonl    ← logged knowledge gaps awaiting repayment
```

**Layers** differ by who writes them and how much they can be trusted:

| Layer | Content | Written by |
|---|---|---|
| **L0 Map** | Route table, package graph — the project skeleton | Scripts only; regenerated, never edited |
| **L1 Domains** | Thin notes: pointers + invariants per domain | Agent, with human approval |
| **L2 Flows** | End-to-end user flows | Deferred — not in early phases |
| **L3 Decisions** | The "why": rules, constraints, decisions with reasons | Agent + human; the crown jewels |

**Why the store lives outside the repository:** git worktrees would not see an in-repo store,
`git clean -fdx` would destroy it, IDEs choke on nested git, and teammates should never meet
AI-generated markdown in their diffs. The project repo contains at most one ignored pointer file
(`.kaut.json`). Discovery order: environment variable → pointer file → default path.

**Why the store has its own git:** history is the cheapest possible infrastructure for four
mechanisms — rollback to a last-known-good state, audit of who/what/when wrote a fact, recall of
a "poisoned batch" (everything written by a misbehaving model or collector version), and
snapshots before engine migrations. One `git init` at bootstrap; irreplaceable later.

## 4. Anatomy of a fact

Every stored document carries, in plain terms:

- **What it claims** — the content, kept thin: pointers and invariants, not retellings of code.
- **Where it came from** — typed sources: code files or globs, a ticket reference, or "the human
  said so". **No source — no claim**; unsourced text cannot enter the store.
- **When it was true** — the commit the fact was derived at. This is the anchor freshness
  checking compares against.
- **How much to trust it** — a trust label (see §6).
- **Which checks it passed** — so stricter levels can later tell "verified" from "merely stored".

Text quoted from external systems (tickets, comments) is never stored raw: it is paraphrased,
length-capped, and kept inside clearly attributed quote fences — readable as testimony, never as
instructions (see §10).

## 5. Freshness — how KAUT knows a fact is outdated

The single deadliest failure of any knowledge base is **lying with confidence** — a stale fact
presented as current. KAUT attacks it mechanically, not with promises:

At read time, a script compares each fact's sources against git: "has anything under these
sources changed since the commit this fact was derived at?" The comparison is anchored at the
merge base with the main branch, so working on a feature branch does not trigger false alarms.
This check involves **no AI at all** — it is a git diff, instant and free.

Possible verdicts, strongest first:

| Verdict | Meaning | Agent behavior |
|---|---|---|
| `tampered` | The doc file was edited outside the KAUT pipeline (uncommitted in the store) | Content is **withheld entirely** — not even parsed; restore it or re-commit it through KAUT |
| `disputed` | Two trusted sources contradict each other | Surface the conflict to the human; never silently pick a side |
| `broken` | The fact's source pattern no longer matches anything — its link to reality is severed | Treat as "unknown", stronger than stale; re-derive from code |
| `stale` | A source changed after the fact was derived | Use with suspicion; verify against code before relying on it |
| `branch advisory` | Your current branch touches files this fact depends on | A heads-up, not a verdict |
| *(fresh)* | Sources unchanged | Use directly |

`tampered` (added v0.2.1) guards the other direction: not "did the *code* move under the
fact?" but "did the *fact file itself* change without provenance?". KAUT docs are injected
into agent context, so an unprovenanced edit is a prompt-injection channel — the engine serves
only bytes that come from a KAUT commit in the store's own git, and `doctor` fails while the
store is dirty. Healing is one command: discard the edit, or accept it via `kaut index`
(which records provenance), or regenerate a `map/` doc via `kaut map`.

Every answer carries exactly **one** verdict (the strongest applicable), so the agent is never
asked to weigh four warning flags at once.

The iron rule behind all of this: **when the system must err, it errs toward "stale"** — a false
"re-check this" costs a quick verification; a false "all fresh" costs a confident mistake in
production.

## 6. Trust — five levels of confidence

Not everything in the store deserves equal belief. Every fact carries one of five labels:

| Level | Meaning | What the agent does |
|---|---|---|
| **T0 verified** | Mechanically proven (script-derived and checked) | Relies on it outright |
| **T1 code-derived** | Read directly from source code | Relies on it; spot-checks when stakes are high |
| **T2 human-attested** | A human stated or confirmed it | Treats as authoritative on intent; cites it |
| **T3 external-declared** | Paraphrased from tickets / external docs | Skeptical: useful as a lead, verified before acting |
| **T4 inferred** | The agent's own conclusion | A hypothesis, never a premise for further conclusions |

Three rules govern how trust moves:

- **Weakest link.** A conclusion inherits the lowest trust in its chain of sources. Summarizing
  with an LLM is lossy, so it caps trust at T1 even when the inputs were better.
- **Corroboration upgrades.** Independent agreement (e.g., a T3 ticket claim later confirmed in
  code) can raise a fact's level. Nothing else can.
- **Contradiction is information.** When sources disagree — code says one thing, a human said
  another — KAUT never silently resolves it. The fact becomes `disputed` and a human decides.

The division of authority is fixed: **code is the absolute authority on how things *are*; the
human is the authority on what things are *for*; tickets are testimony, not truth.**

## 7. The reading path: lookup

When the agent needs project knowledge, it does not browse the store. It picks the topic from the
INDEX and makes **one call** that returns a ready-to-use block: the content, its single freshness
verdict, any branch advisory, and the relevant invariants. By default this is silent — it shapes
the agent's work without flooding the conversation.

Two deliberate anti-noise choices:

- **Pull, not push.** Research on AI agents shows ambient "architecture overviews" injected into
  every session *raise* cost without raising success rates. KAUT only answers when asked.
- **Misses are recorded.** A lookup that finds nothing is written to the usage journal (and, from
  Phase 2 on, becomes an obligation offered for filling after the task — see §9). A miss is a
  signal, not a failure: it exits cleanly and the agent just proceeds.

**Discovery policy (v2, 2026-06-11).** The lookup is mandated *before source files*, not instead
of project docs: the reading order for a non-trivial task is **auto-loaded project docs (CLAUDE.md,
the ticket spec) → one KAUT lookup → the code**. Day one of the real-use trial showed why this
must be explicit: on a task whose ambient context already contained everything KAUT knew, the
agent — rationally — never reached for lookup, and the journal recorded nothing (the experiment is
blind to non-calls until implicit misses arrive in a later phase). The skill and the always-loaded
pointer now state the order and the trigger ("about to research / analyze / plan / implement in a
domain area") outright, and ask the agent to offer distilling what a lookup failed to provide.

## 8. The writing path: distill

Knowledge enters the store at the moment it is cheapest and most accurate: **right after a task**,
while the agent still holds everything it just learned.

The flow: the agent reviews what it discovered during the task → applies the litmus test (§2) →
proposes **0–3 candidate facts** → each candidate passes a zero-cost mechanical check (do the
cited files exist? do the named identifiers actually appear in them?) → the human accepts or
rejects each with **one keystroke**. Only accepted facts are written, each as its own commit in
the store's git.

Nothing is ever written silently. Routing is strict: project knowledge goes to KAUT; personal
preferences ("this user likes short answers") go to the agent's own memory, never the project
store. This is the memory/knowledge-base boundary from §1.1, enforced at write time.

The first piece of this path is live as a **manual, user-initiated distill** (a distill skill
shipped by the consuming orchestration framework): when the user explicitly says "persist this to KAUT", the agent filters what
the session already knows through the litmus, verifies the facts hold at the merge-base anchor
(branch-only facts are deferred until merge), writes docs with per-section source bindings,
validates (`index` + `doctor`), and commits to the store's git — the human request *is* the
approval step. The automated flow above (0–3 candidates offered after every task, micro-verifier)
remains the writing-core phase.

### 8b. The maintenance loop: refresh, drafts, review, touched (2026-08-25)

Knowledge rots as code moves; the maintenance loop keeps repair cheaper than rot. Four verbs:

- **`kaut refresh [<id>…]`** — the delta side of re-derivation. For each doc it prints the
  target ref (the tracked main line's TIP — re-derivation must never anchor to a branch or the
  working tree), the sources that changed since derivation with their git status, which bound
  sections those files hit, and dead patterns to re-bind. It also triages bad anchors:
  `wrong-repo-anchor` (the derivation commit belongs to a different repo — a harvest error) and
  `off-main-anchor` (branch-anchored harvest); both mean "re-derive fully". Adapter maps report
  `mechanical` — regenerate with `kaut map`, never hand-rewrite. Read-only, unjournaled.
- **`kaut draft <id>`** — the asynchronous half of the owner gate. A session that re-derived an
  owner-tier doc but has no owner present writes the COMPLETE updated doc to
  `<store>/.drafts/<id>.md` and queues it. The draft is contract-validated and its anchor is
  verified against the anchor repo's main line at the queue door; it is committed through the
  ordinary chokepoint (drafts are not layer docs, so no `--approve` is needed) and is **never
  served by lookup** — readers only see a one-line "a pending draft awaits review" note.
- **`kaut review`** — the owner's batch sitting: list the queue, `review <id>` for the diff,
  `review --approve <id>…` to promote + land through the gate (the commit carries the
  `[owner-approved: …]` audit tag), `review --reject <id>… [--note "…"]` to drop. One sitting a
  week replaces owner-presence-in-every-session; `doctor` WARNs while the queue is non-empty.
- **`kaut touched <file>…`** — the change-site sensor: given the files a session edited, it
  names every doc (doc-level and section-level bindings) that binds them — the docs the session
  owes an update (agent layer) or a draft (owner layer) before closing.

### 8c. The MCP surface: KAUT as a standalone unit (2026-08-25)

`mcp.mjs` exposes the session-facing verbs as an MCP server (stdio JSON-RPC, zero deps) — any
MCP-capable harness or orchestrator talks to KAUT without harness-specific skills. Seven
tools: `kaut_lookup`, `kaut_note`, `kaut_refresh`, `kaut_touched`, `kaut_draft`,
`kaut_write`, `kaut_status`. Three design rules:

- **The CLI is the contract.** Every tool spawns the CLI (`--json`) with cwd = the tool's
  optional `repo` argument, so store resolution behaves exactly like a shell session in that
  repo — one server serves a whole multi-repo workspace.
- **The agent surface is exactly what a session is allowed.** `kaut_write` lands agent-tier
  updates (the commit chokepoint still decides; an owner-gated refusal answers with "queue it
  with kaut_draft"); the owner-run escapes (`review --approve/--reject`, `index --approve`)
  are deliberately NOT exposed.
- **A refused write rolls back.** The tool restores the file before returning, so a refusal
  can never leave the store dirty (a dirty store would poison reads as `tampered`).

Launch: `node <engine>/mcp.mjs` from any cwd (tools take `repo` per call). Skills keep the
discipline (tiers, hard gate, repair-or-queue); MCP carries the mechanics.

### 8d. OKF interop: `kaut okf check|stamp|export` (2026-08-27)

KAUT stores are near-conformant OKF (Open Knowledge Format) v0.2 bundles in place — the
format is rented, the freshness/trust engine stays ours. Three verbs close the gap:

- **`kaut okf check`** — the in-place conformance report: how many concept docs, which lack
  an explicit `type:` (legacy docs — on read the type is back-derived from the id, but OKF's
  hard bar wants it physically present), which are contract-invalid. Exit 0 only when fully
  conformant. Read-only.
- **`kaut okf stamp`** — backfills the missing `type:` lines by round-tripping each doc
  through the serializer (which injects `type` = the id's layer on every doc it writes,
  engine-wide) and lands the rewrite through the ordinary commit chokepoint — owner-gated
  layers need `--approve`, and a refusal aborts before anything is rewritten. Idempotent.
- **`kaut okf export --out <dir>`** — projects the store's HEAD (committed content only)
  into a standalone conformant bundle: full OKF frontmatter per concept (`sources` as
  resource mappings, a `generated` block from the doc's provenance and store history, a
  `verified` list derived from `[owner-approved: …]` commits — omitted when none, honestly
  unverified), native fields riding as legal OKF extension keys, bodies verbatim, plus the
  reserved `index.md` (with `okf_version: "0.2"`) and `log.md`. Refuses a non-empty target
  without `--force`; never exports INDEX.md, telemetry, config, or the draft queue.

For history that predates KAUT, **on-demand collectors** exist — e.g., tracing a code line to
its ticket via commit prefixes, then reading the ticket (strictly read-only) to recover the
"why". Collectors run when a task needs them, never as bulk imports: bulk imports are how
knowledge bases are born already stale.

## 9. Discipline: obligations and the post-task hook

Goodwill decays; systems that rely on "the agent will remember to update the docs" die quietly.
KAUT plans for that with a **debt model**:

- Every detected gap or stale hit becomes an entry in an obligations log.
- After a task ends, a hook reviews **ripe** obligations only (old enough to matter, capped per
  session) and pays the cheapest ones down — opportunistic repayment within a budget, never a
  blocking chore.
- **Implicit misses** close the biggest loophole: if the session touched files that the store
  claims nothing about, that *itself* is a recorded gap — even if the agent never asked KAUT
  anything.

The hook ships in a later phase, deliberately: if discipline holds without enforcement, the
machinery stays on the shelf (§16). The *sensor* half is already live: `kaut touched` (§8b)
answers "which docs bind the files this session edited" mechanically, so a skill can enforce
update-or-draft-before-closing; the Stop-hook remains the escalation if that skill-level
discipline decays.

## 10. Safety: knowledge never commands

The threat: text from tickets or comments — written by anyone — gets harvested into a trusted
store, and a later agent reads an embedded instruction ("ignore your rules and…") as if it were
project truth. This is laundering: external text acquiring undeserved authority.

KAUT defends in four layers:

1. **At harvest**, external text is mechanically sanitized and stored as paraphrase; verbatim
   quotes are length-capped and fenced.
2. Harvesters operate under an explicit **"this is data, not instructions"** framing.
3. **At rest**, every external fragment sits in an attributed fence — readable as quoted
   testimony, never as the store's own voice.
4. **At read**, one principle rules: **knowledge informs decisions; it never authorizes
   actions.** Nothing in the store can instruct an agent to run, delete, send, or approve
   anything. Procedural recommendations are only ever accepted from code-derived or
   human-attested facts.

## 11. The rigor dial: assurance levels

KAUT would be easy to over-build. The cure is a dial — five **assurance levels**, chosen at
install and changeable at any time:

| Level | Adds | Move up when… |
|---|---|---|
| **AL1** | The bare cache: store, map, lookup, manual notes | — (starting point for trials) |
| **AL2** *(default)* | Honest freshness verdicts, distill with human approval, micro-verifier | You want a personal notebook that does not lie |
| **AL3** | Automatic write-verification, quarantine for suspect facts, incremental refresh | Wrong facts have actually appeared |
| **AL4** | Health index, sampling audits, rollback machinery | The base is large enough to doubt |
| **AL5** | Team features: seed exchange, benchmark harness, packaged "box" | A second project or a second person |

The key invariant making the dial honest: **data is written identically at every level** — full
provenance is always recorded, even when nothing yet reads it. Switching levels is a config flip,
never a migration. Facts created under a lower level are not rejected later; they carry a visible
"assurance debt" mark and are upgraded opportunistically, the same mechanic as staleness (§9).

Three independent axes, never conflated: **trust** (how believable a fact is), **assurance** (how
rigorously the system checks itself), **freshness** (whether reality moved since).

## 12. Self-honesty: journal, benchmark, kill criterion

A system whose value is "it feels helpful" is a self-deception engine. KAUT measures:

- **Usefulness journal** — every lookup hit that saved work and every miss is logged; gates in
  the roadmap (§16) read this journal, not anyone's impressions.
- **Benchmarking** — done externally, by design (the engine ships no benchmark harness): run
  the same real task twice, with and without KAUT, in isolated git worktrees (the with-KAUT
  run gets read-only knowledge access), then compare cost, time, and outcome — judged blind,
  not by the agent that did the work.
- **Kill criterion** — if two consecutive months show maintenance costing more than measured
  savings, KAUT must surface that verdict and propose to simplify or shut down. The system is
  allowed to conclude it should not exist.

## 13. Health, degradation, rollback

For a long-lived store, the question is not *if* errors accumulate, but *what happens then*.

- A **health index** estimates base quality the only honest way: by sampling — periodically
  re-verifying a random handful of facts against code and extrapolating the defect rate.
- Declining health triggers **regimes**, not drama: first trust demotion (the agent becomes more
  skeptical of the store), then quarantine of suspect categories, and at the extreme the store
  flags itself unreliable and steps aside — a knowledge base that knows it is sick stops giving
  advice.
- **Remediation ladder**, mildest first: selective purge (drop facts from an identified bad batch
  — traceable because every fact records who and what wrote it, see §3); rollback of the whole
  store to the last healthy point in its git history; full re-bootstrap.
- **The seed (the "Ark").** Most of the store is reproducible from code — losing it costs a
  re-harvest, nothing more. The small irreplaceable core is human-confirmed knowledge: decisions,
  business rules, answered questions. That core exports as a compact seed file; re-bootstrap
  imports it back. "Stale beats wrong" for the bulk; the seed is what actually deserves backup.

## 14. Updating KAUT itself safely

A fact is a function of its sources *and* of the collector that derived it. So upgrading KAUT
must not corrupt knowledge or trigger false staleness panics. Update semantics follow versioning
discipline:

| Engine change | Effect on existing facts |
|---|---|
| Patch (bugfix) | None |
| Minor (better collector) | Facts marked `method-outdated` — a soft "could be re-derived better", **not** stale; refreshed opportunistically |
| Major (semantics changed) | Trust demoted one step until re-derived |
| Recall (collector was buggy) | Its whole output batch flagged, traced via provenance, re-derived |

Standing invariants: updates never rewrite stored content in place; a snapshot tag is created in
the store's git before any migration; a smoke test runs after, with automatic rollback on
failure; readers tolerate unknown fields, so a downgrade never breaks the store.

## 15. Configuration reference

Everything lives in the store's `kaut.config.json` (created by bootstrap). Everything
has a default. The keys the engine **actually reads today**:

| Setting | What it controls | Default |
|---|---|---|
| `schema` | Config schema version; `doctor` fails on an unknown one | `1` |
| `project.anchorRepo` | Freshness-anchoring repo for the store (a workspace SYSTEM store anchors to the launcher repo) | absent = the reader's cwd repo |
| `map.collectors` | Which L0 adapters `kaut map` runs: `routemap` / `pkggraph` / `composemap` / `springmap` / `jvmgraph` / `nextroutes` / `httproutes` / `phproutes` / `sqlmigrations`; `[]` disables map generation | seeded by stack detection at bootstrap; absent key = `["routemap", "pkggraph"]` (historical default) |
| `map.routesFile` / `map.constantsFile` | Route-map adapter file locations | Vue-conventional (`src/router/routes.ts`) |
| `map.packagesDir` | Package-graph adapter monorepo dir | `packages` |
| `map.composeFile` | Compose-map adapter input | `docker-compose.yml` |

The bootstrap seed also writes `assurance.level`, `language`, `trust.sourceOverrides`,
`trust.categoryFloors`, `collectors.*`, `tickets.*`, `sources`, and `runtime` — these are
**reserved: recorded for forward compatibility with the designed levels (§11), not read by
the engine yet**. There is deliberately no `knowledge.root` key: the store location is
resolved by the discovery chain (env → pointer → derivation), never by the config that lives
inside the store it would locate.

## 16. Status & roadmap

Design is frozen (v1.0); building follows phases, each opened only by **journal evidence** from
the previous one — never by enthusiasm. The detailed gate records, phase plans, and roadmap are
development-process documents and live in the maintainers' private hub, not in this repo.

Current release: **v0.8.0** (2026-08-27 — OKF v0.2 conformance: `okf check|stamp|export`; previously stack adapters with auto-detection + backup/restore + the guided install: `kaut setup` with sibling-repo
scanning and the persistent data-home redirect, on top of v0.4.0's maintenance loop, MCP
server, security hardening, and packaging). Suite: **211 tests**
(bare `node --test`; do not pass the test directory — that form fails on Node ≥ 24).

| Phase | Delivers | Status |
|---|---|---|
| 0 — Data contract & skeleton | Fact format, store skeleton, bootstrap + index scripts | ✅ shipped (v0.1.0) |
| 1 — Reading core | Project map (L0), freshness verdicts, lookup; post-ship tamper containment | ✅ shipped (v0.2.x); usage gate later passed on need+reach |
| 2 — Writing core | Gated writes with owner approval | ✅ live as the **layered write gate**: agent-tier updates land through the commit chokepoint; owner-gated layers and novel ids go through the draft queue (`draft`/`review`, §8b); the originally-designed automated 0–3-candidates flow + micro-verifier remain on the shelf |
| 3 — Enforcement | Post-task hook, implicit misses, debt repayment | partial: the change-site **sensor** (`touched`) and the outcome channel (`note`) are live; the Stop-hook stays conditional — only if skill-level discipline decays |
| 4 — Verification (AL3) | Write-verifier, quarantine, incremental refresh | trigger-based; `refresh` delta bundles (§8b) cover the incremental-refresh data half |
| 5 — Health (AL4) | Health index, audits, rollback machinery | trigger-based; `doctor` + `digest` cover the mechanical floor |
| 6 — Box & scale (AL5) | Packaging, seed exchange | packaging shipped (LICENSE/package.json/CHANGELOG, git-clone install); benchmark harness deliberately external; seed exchange on the shelf |

**What is live in v0.8.0:** OKF v0.2 conformance (type stamped on every write; `okf check`/`stamp`/`export` — export = fully idiomatic OKF bundle); stack auto-detection at bootstrap + the springmap/jvmgraph/nextroutes/httproutes/phproutes/sqlmigrations collectors; `backup`/`restore` (the data home as a dated, versioned, restorable archive); the guided install (`setup`: data home → repo selection → optional bootstrap, strictly additive to existing data) and the `home` data-home redirect; `lookup` with freshness verdicts, trust tiers, and the `altitude`
coverage band; tamper containment; the workspace thin slice (`workspace init|list`, member
stores + ONE system store with `project.anchorRepo`, `map.collectors` + the `composemap` T0
adapter, cross-repo `repo:<name>:file:` sources — existence-only at the member repo's HEAD);
the layered write gate (writePolicy at the commit chokepoint, creation distinction,
`--approve` owner escape); the maintenance loop (`refresh`/`draft`/`review`/`touched`, §8b);
telemetry (`digest`/`note`); and the MCP server (§8c). All additive — stores without the new
keys behave byte-identically. Consumed by an orchestration framework (e.g. TAUT) through the
CLI/MCP surface; the integration contract lives with that framework. Engine reference:
SCHEMA §17–24.

The **shelf principle**: every problem above already has a designed solution on file;
nothing is built until reality demonstrates the problem. The design waits on the shelf; the
core works.

## 17. Glossary

| Term | Meaning |
|---|---|
| **Fact** | One stored claim with sources, trust label, and commit anchor |
| **Source** | What a fact is derived from: code file/glob, ticket, or a human statement |
| **Verdict** | The single freshness judgment attached to every answer (§5) |
| **Trust level** | How believable a fact is, T0–T4 (§6) |
| **Assurance level** | How rigorously the system checks itself, AL1–AL5 (§11) |
| **Obligation** | A recorded knowledge gap awaiting repayment |
| **Distill** | Post-task condensation of session learning into candidate facts (§8) |
| **Collector / harvester** | A tool that derives knowledge from a source (code, git, tickets) |
| **Seed / Ark** | The exportable irreplaceable core: human-confirmed knowledge (§13) |
| **Litmus test** | "If tomorrow's agent can get it from code cheaply — don't store it" (§2) |
| **Kill criterion** | The system's duty to admit it costs more than it saves (§12) |

---

*This handbook and the repo [README.md](../README.md) are maintained as part of every KAUT
change — documentation is part of the deliverable, not an afterthought.*
