# KAUT documentation

The product narrative, quickstart, and full command reference live in the repo
[README.md](../README.md). This directory holds the deeper references:

- [HANDBOOK.md](HANDBOOK.md) — the complete technical guide, written for humans: what KAUT
  actually does and why it works (freshness, trust, the write path, the maintenance loop,
  configuration reference, status & roadmap).
- [OPERATIONS.md](OPERATIONS.md) — operator reference: on-disk layout, resolution order,
  tamper containment and the write gate in detail, uninstall, engine internals.
- [MCP.md](MCP.md) — the MCP server reference: registration per harness, all 7 tools,
  protocol details.
- [AGENT-INTEGRATION.md](AGENT-INTEGRATION.md) — wiring agents to the store: the knowledge
  contract, skill template, a worked session.
- [../SCHEMA.md](../SCHEMA.md) — the normative data contract: everything KAUT writes to
  disk, and the read-time semantics built on it.
- [../CHANGELOG.md](../CHANGELOG.md) — release history.

Development-process documents (roadmap, phase plans, reviews, strategy) live in the
maintainers' private hub, not in this repo — project folders carry project documentation
only.
