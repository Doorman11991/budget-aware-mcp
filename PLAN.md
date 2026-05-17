# code-graph-mcp — Development Plan

## Architecture

Fork [DeusData/codebase-memory-mcp](https://github.com/DeusData/codebase-memory-mcp) (MIT licensed) as the foundation. Replace their retrieval layer with our hop-based graph walk. Keep everything else.

```
┌─────────────────────────────────────────────────────────────┐
│  AI Agent (Claude Code / Cursor / Aider / Codex / etc.)     │
│  ↓ MCP protocol                                            │
├─────────────────────────────────────────────────────────────┤
│  code-graph-mcp server (this project)                       │
│  ┌─────────────────┐  ┌──────────────────────────────────┐ │
│  │  14 MCP tools    │  │  Budget/trace/cost tracker       │ │
│  └────────┬────────┘  └──────────────────────────────────┘ │
│           │                                                 │
│  ┌────────▼────────────────────────────────────────────┐   │
│  │  RETRIEVAL LAYER (our code — the differentiator)     │   │
│  │  • hop-based graph walk (anchor + depth + budget)    │   │
│  │  • deterministic ordering                            │   │
│  │  • scope/feasibility check                           │   │
│  │  • token-budget-aware truncation                     │   │
│  └────────┬────────────────────────────────────────────┘   │
│           │                                                 │
│  ┌────────▼────────────────────────────────────────────┐   │
│  │  INDEX LAYER (forked from DeusData — battle-tested)  │   │
│  │  • tree-sitter 155-lang parsing                      │   │
│  │  • SQLite persistence (in-memory + on-disk)          │   │
│  │  • LZ4 compression                                   │   │
│  │  • infra indexing (Docker/k8s/Kustomize)             │   │
│  │  • cross-repo shared graph                           │   │
│  │  • incremental re-indexing                           │   │
│  └─────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

---

## What we keep from DeusData (steal)

| Component | Reason |
|---|---|
| Tree-sitter 155-language parsing | Not rebuilding grammar support for 155 languages |
| SQLite persistence (in-memory + on-disk) | Zero-config, ships as a single file, millisecond queries |
| LZ4 compression | Free size win on cached index |
| Infrastructure indexing (Docker/k8s/Kustomize) | Real-world repos have infra; agents need to see it |
| Cross-repo intelligence | Monorepos, microservices — agents need the full picture |
| MCP server skeleton + 14-tool surface | The agent-facing API contract. Already well-designed. |
| Auto-configure for 7+ AI agents | UX. Average users shouldn't have to edit JSON configs. |
| Impact analysis (blast radius from git diff) | High value for agents planning refactors |
| 3D graph visualization (optional UI) | Demo/debug surface. Nice to have. |
| Call graph construction (callers/callees/imports) | The raw edges we'll walk during retrieval |

## What we replace (code ourselves)

| Component | Their approach | Our approach | Why ours wins |
|---|---|---|---|
| **Retrieval** | TF-IDF + embeddings + graph diffusion + MinHash | Hop-based graph walk from anchor symbols | Deterministic, instant, no model dependency, structurally precise |
| **Ranking** | Semantic similarity scores | Hop distance + node degree + file relevance | No false positives from "vibes" |
| **Budget awareness** | None | Token tracking per query, per session, per repo | Agents know exactly how many tokens they're spending |
| **Scoping/feasibility** | None | "Is this task achievable with the available context?" pre-check | Prevents wasted generation attempts |
| **Deterministic ordering** | Unspecified | Alphabetical within each hop level, content-hash-stable | Same query = same result, always |
| **Cost reporting** | None | Every response includes `{ tokens_saved, files_returned, total_context_bytes }` | Users see the value |

## What we add (new features, not in either codebase)

| Feature | Value |
|---|---|
| **Token budget parameter on every query** | Agent says "give me context for this task, max 8000 tokens" — retriever stops when budget is hit |
| **Multi-hop depth control** | `hopDepth: 1` = just direct imports. `hopDepth: 3` = full dependency tree. Agent picks the precision/cost tradeoff. |
| **Anchor symbols** | "Start from this function/class and walk outward" — most specific retrieval possible |
| **Scope check tool** | Before an agent generates code, it asks: "is this feasible given what I can see?" — returns feasibility + missing pieces |
| **Session-level token accounting** | Running total of tokens saved across all queries in a session. The agent (or user) sees cumulative savings. |
| **Per-repo stats** | "This repo has 50k files, 2M LOC, 12k functions. Your queries have covered 3% of it." |
| **Change-aware retrieval** | "What's changed since last query?" — incremental context for iterative development |

---

## Phase plan

### Phase 1 — Fork + strip (1-2 days)

1. Fork DeusData/codebase-memory-mcp
2. Strip the retrieval layer (TF-IDF, embeddings, Nomic model, MinHash, graph diffusion)
3. Keep: tree-sitter parsing, SQLite persistence, LZ4, infra indexing, MCP server, auto-config, cross-repo, call graph construction
4. Verify: `npm install && npm test` passes with retrieval stripped (tests that depend on embedding retrieval get replaced with stubs)
5. Mark it private, push to your GitHub

### Phase 2 — Our retrieval layer (2-3 days)

1. Implement `src/retrieval/graph_walk.ts`:
   - `walk(graph, anchor, hopDepth, maxTokens)` → `{ files, symbols, token_estimate }`
   - Walk strategy: BFS from anchor symbols, hop along import/call/class-inheritance edges
   - Token estimation: `file.length / 4` (conservative char-to-token ratio)
   - Budget enforcement: stop adding files when `token_estimate > maxTokens`
   - Deterministic ordering: alphabetical within each hop level
2. Implement `src/retrieval/scope_check.ts`:
   - Given a task description + available context, return `{ feasible: bool, missing: string[], confidence: float }`
   - Pure heuristic (no LLM): checks if the task mentions symbols that exist in the graph
3. Wire into MCP tools: replace `search_graph` / `query_graph` internals with our walk
4. Test: same query returns same result across 100 runs (determinism)

### Phase 3 — Budget/cost tracking (1 day)

1. Implement `src/tracking/budget.ts`:
   - Per-query: `{ tokens_returned, tokens_saved_vs_full_file_read, files_returned, query_ms }`
   - Per-session: running totals
   - Per-repo: cumulative stats (total indexed, % covered by queries)
2. Every MCP tool response includes a `_meta` field with these stats
3. New MCP tool: `get_session_stats` — returns the running totals

### Phase 4 — Agent auto-configure (1 day)

1. Keep DeusData's existing auto-config for: Claude Code, Codex CLI, OpenCode, Aider, Gemini CLI, Zed
2. Add: Cursor, Kiro, Windsurf
3. Installer: `npx code-graph-mcp install` detects installed agents, writes their MCP config
4. Verify each agent can discover + call our tools after install

### Phase 5 — Cross-repo (1-2 days)

1. Keep DeusData's cross-repo graph store
2. Add: `index_repo` tool that agents call to add a new repo to the graph
3. Add: `list_repos` tool showing what's indexed
4. Add: cross-repo edge display in `trace_call_path` (follows imports across repo boundaries)
5. Test: index 3 repos, query a function in repo C that imports from repo A → returns context from both

### Phase 6 — Polish + ship (1-2 days)

1. README with install instructions per agent
2. Benchmarks: token savings vs raw file reads on 5 real repos (small/medium/large/monorepo/polyglot)
3. npm package (private — `npm install` from git URL)
4. CLI: `code-graph-mcp serve` starts the server
5. CLI: `code-graph-mcp index <path>` indexes a repo
6. CLI: `code-graph-mcp query <anchor> --depth 2 --budget 4000` for manual testing

---

## Non-goals (explicit)

- **No embedding model** — the whole point is graph retrieval without one
- **No cloud dependency** — everything runs local
- **No model-specific code** — works with any agent that speaks MCP
- **No UI required** — the 3D viz is optional and inherited from the fork
- **No breaking changes to existing MCP tool schemas** — existing agent integrations keep working

---

## Success metrics

| Metric | Target |
|---|---|
| Token efficiency vs file exploration | ≥100x fewer tokens for equivalent answer quality |
| Query latency (p95) | <10ms for repos under 100k LOC |
| Index time (cold) | <5s for repos under 100k LOC |
| Language coverage | 155 (inherited from tree-sitter) |
| Agent compatibility | 9+ (Claude Code, Cursor, Kiro, Aider, Codex, OpenCode, Gemini CLI, Zed, Windsurf) |
| Determinism | 100% — same query always returns same result |

---

## Timeline

| Phase | Estimate | Depends on |
|---|---|---|
| 1. Fork + strip | 1-2 days | nothing |
| 2. Retrieval layer | 2-3 days | Phase 1 |
| 3. Budget tracking | 1 day | Phase 2 |
| 4. Agent auto-config | 1 day | Phase 1 |
| 5. Cross-repo | 1-2 days | Phase 2 |
| 6. Polish + ship | 1-2 days | all |
| **Total** | **7-11 days** | |

---

## Tech stack

- **Runtime:** Node.js 18+ (same as all target agents run on)
- **Parser:** tree-sitter (vendored grammars, inherited from fork)
- **Storage:** SQLite (better-sqlite3, in-memory for speed, on-disk for persistence)
- **Compression:** LZ4 (inherited from fork)
- **MCP protocol:** @modelcontextprotocol/sdk
- **Language:** TypeScript (strict mode)
- **Test runner:** node:test (built-in, zero deps)
- **Build:** tsup or esbuild for single-file distribution
