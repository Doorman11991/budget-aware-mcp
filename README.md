# code-graph-mcp

A model-agnostic code intelligence MCP server for AI agents. Graph-based retrieval that's 120x more token-efficient than file exploration — no embeddings, no vector DB, no API keys.

**Status:** Planning. See [PLAN.md](./PLAN.md) for the detailed roadmap.

## What it does

Any AI agent (Claude Code, Cursor, Kiro, Aider, Codex, OpenCode, Gemini CLI, Zed) gets instant structural understanding of any codebase through MCP tools — without reading files manually or wasting tokens on irrelevant context.

## Core thesis

Graph retrieval > embedding retrieval for code. When an agent asks "what's relevant to this task?", following actual imports and call sites gives better results than semantic similarity — and it's deterministic, instant, and free.

## Key differentiators vs existing tools

- **No embedding model required** — works offline, no GPU, no API keys
- **Deterministic** — same query always returns same files
- **Budget-aware** — tracks how many tokens you're saving per query
- **155 language support** via tree-sitter
- **Millisecond queries** — RAM-first SQLite index
- **Cross-repo intelligence** — monorepos, microservices, distributed architectures as one graph
- **Infrastructure-aware** — Dockerfiles, k8s, Kustomize as graph nodes

## License

Private. Not for distribution.
