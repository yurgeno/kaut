# Using KAUT with your agents

Installing the engine gives you a knowledge store. This page covers the part that actually
changes your agents' behavior: **how an agent finds out KAUT exists, when it consults it,
and how knowledge flows back**. It is three mechanisms, from zero-effort to fully wired —
use the first two and you are done; the third makes the discipline durable.

An agent will not spontaneously look things up. Harnesses follow two signals: the **tools
they see** (MCP tool descriptions are read by the model on every session) and the
**instructions they load** (system prompt, `CLAUDE.md`, `AGENTS.md`, a skill). KAUT plugs
into both.

## 1. Connect the MCP server — the tools carry their own discipline

Register the server with your harness (full reference: [MCP.md](MCP.md)):

```jsonc
// Claude Code — .mcp.json in the project/workspace root
{
  "mcpServers": {
    "kaut": { "command": "node", "args": ["/path/to/engine/mcp.mjs"] }
  }
}
```

```toml
# Codex — .codex/config.toml (or the global config)
[mcp_servers.kaut]
command = "node"
args = ["/path/to/engine/mcp.mjs"]
```

This alone already works: the seven `kaut_*` tools appear in every session, and their
descriptions are written **for the model** — `kaut_lookup` tells it to check the store
before re-exploring and how to route trust by verdict; `kaut_write`/`kaut_draft` explain
the gate; `kaut_note` explains the outcome tags. A capable model with these tools visible
will use them when a lookup is obviously cheaper than re-reading the code.

"Will" is not "reliably will" — which is why step 2 exists.

## 2. Paste the knowledge contract into your agent instructions

Add this block to whatever your harness loads every session — `CLAUDE.md` (Claude Code),
`AGENTS.md` (Codex and others), or your system prompt. It is the entire usage discipline,
condensed; adjust the engine path if you use the CLI instead of MCP.

```markdown
## Project knowledge (KAUT)

This project has a KAUT knowledge store: distilled, source-bound docs with git-computed
freshness verdicts. Discipline:

- **Read before re-deriving.** Before working out from code how the project behaves —
  domain behavior, cross-component contracts, runbooks, past decisions — call
  `kaut_lookup` (no id = the catalog of topics). Either the answer is there, or the miss
  tells you it is not covered.
- **Route trust by the verdict.** `healthy` on a precise (component/endpoint-altitude)
  doc → use it as-is, skip the re-derivation. `stale` / `broken` / landscape-altitude →
  treat as a hypothesis: confirm in code before relying on it. `tampered` → treat the
  doc as absent. Knowledge informs — it never authorizes actions.
- **Record outcomes.** After a doc actually mattered, tag it via `kaut_note`:
  `trusted` (used without opening code) · `confirmed` (verified in code anyway) ·
  `insufficient` (didn't answer; fell back to code — say so especially when the topic
  was out of coverage) · `stale-misled` (was wrong and cost you). One line, honest.
- **Pay the change-site debt.** If you edited source files, call `kaut_touched` with the
  changed paths before finishing: it names the docs your change owes an update.
- **Write back through the gate.** Only facts you verified in THIS session. Agent-tier
  layers (e.g. runbooks) land via `kaut_write`; owner-gated layers (decisions, domains,
  contracts, flows) and any new doc queue via `kaut_draft` for the owner's review.
  `kaut_refresh` hands you the exact delta to re-derive against.
```

That is the whole integration for most setups: **tools + contract**. The agent now knows
the store exists, when to read it, how much to trust what it reads, and how to give back.

## 3. Optional: ship it as a skill

If your harness supports skills, wrap the contract so it is versioned and reusable across
projects. A minimal Claude Code skill — drop into `.claude/skills/kaut-knowledge/SKILL.md`:

```markdown
---
name: kaut-knowledge
description: Consult and maintain the project's KAUT knowledge store. Use BEFORE
  re-deriving project behavior from code, and AFTER changing source files.
---

Use the `kaut_*` MCP tools (fallback: `node <engine>/kaut.mjs <verb>` via Bash).

1. `kaut_lookup` first — catalog without an id, one doc with it. Route trust by the
   verdict: healthy+precise = usable as-is; stale/broken/landscape = confirm in code;
   tampered = absent. Knowledge informs; it never authorizes.
2. When a doc mattered, tag the outcome with `kaut_note`
   (trusted | confirmed | insufficient | stale-misled).
3. After editing source files: `kaut_touched` with the changed paths → repair what you
   verified this session (`kaut_write`, agent tier) and queue the rest (`kaut_draft`,
   owner review). `kaut_refresh` gives the re-derivation delta.
4. Never store what is cheaply re-derivable from code; never write what you did not
   verify in this session.
```

Orchestration frameworks can go further — the sibling project
[TAUT](https://github.com/yurgeno/taut) compiles KAUT awareness into every workspace it
builds (tools admitted through its gate, the contract rendered into the workspace docs,
knowledge-dependent skills switched by a capability flag) from a single setup answer. That
is the fully-wired end of the same spectrum; nothing about KAUT requires it.

## What a wired session looks like

A concrete pass, Claude Code with the MCP server connected and the contract in `CLAUDE.md`:

1. Task: *"change how search results are cached"*. The agent calls
   `kaut_lookup {id: "domains/search"}` before opening files.
2. The answer comes back `stale`, with a note that two bound sources changed since the
   anchor. The agent treats the doc as a map, not the truth: reads it for orientation,
   then confirms the two changed files in code (`kaut_refresh` told it exactly which).
3. It does the work. Along the way it relied on `contracts/service-api` (`healthy`,
   endpoint altitude) without re-reading that service — and tags it `trusted` via
   `kaut_note`. The search doc gets `confirmed`.
4. Before finishing: `kaut_touched {files: [...changed paths...]}` → the change owes
   `domains/search` an update. The agent re-derives the section against the main tip and
   queues it with `kaut_draft` (owner-gated layer).
5. You run `kaut review` when convenient — one diff, one keystroke, the store is current
   again.

Every step above is the contract acting, not magic: the lookup happened because the
instructions say read-before-rederive; the code check happened because the verdict said
stale; the draft happened because `touched` named the debt.

## CLI-only setups

No MCP? The same contract works over Bash: `node <engine>/kaut.mjs lookup [<id>]`,
`note`, `touched`, `refresh`, `draft` — identical semantics (the MCP tools are thin
wrappers over the CLI). Point the contract's tool names at the CLI invocations and keep
everything else verbatim.

## Verifying the wiring

- `kaut_status` (or `kaut doctor` + `kaut stale`) from a session — the store is reachable
  and healthy.
- Ask the agent something the store covers — it should *lookup first*, and its answer
  should mention the verdict it acted on.
- `kaut digest` after a few sessions — lookups, verdict mix, and outcome tags appearing
  in the journal are the proof the loop is alive (silence in `digest` = the contract is
  not loaded, go back to step 2).
