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

## Fuzzy discovery + natural-language retrieval

Graph walk handles 80% of queries (agent knows what it wants). The other 20% — fuzzy discovery, "I don't know what I'm looking for", cross-domain matching — is handled by a **second retrieval layer that uses the graph's own metadata as the search surface**. No embeddings. No vector DB.

### Techniques (all run against indexed graph metadata, not raw files)

| Technique | What it does | When it fires |
|---|---|---|
| **Symbol name search** | Fuzzy match on function/class/method names. `"auth"` → `AuthService`, `authenticateUser`, `isAuthenticated`, `auth_middleware` | Agent uses a natural-language term that doesn't map to an exact symbol |
| **File path search** | Match against directory structure. `"payment"` → `src/payments/stripe.ts`, `lib/billing/invoice.ts` | Agent is exploring a domain, not a specific symbol |
| **Docstring/comment search** | Indexed JSDoc, `//` comments, README fragments stored alongside their parent symbol | Agent describes intent in plain English |
| **Type signature search** | "Something that takes a User and returns a Token" → grep the graph for `(User) → Token` shaped functions | Agent knows the shape but not the name |
| **Neighborhood expansion** | "I found `AuthService` — what else lives near it?" → return hop=1 from the best match | Bridge from fuzzy match to precise graph walk |
| **Cluster discovery** | "Show me the major subsystems" → top-N connected components by node count | Agent needs architectural overview |
| **Structural similarity** | "Find something shaped like stripe.ts" → match by method-name patterns + type signatures | Cross-domain matching within a single language |

### The flow for "I don't know what I'm looking for"

```
Agent: "I need to understand how errors are handled in this project"

Step 1: Symbol name search
        → finds: ErrorHandler, AppError, handleError, error_middleware,
          ValidationError, HttpError

Step 2: Pick the most-connected symbol as anchor
        (ErrorHandler has highest in-degree = most things reference it)

Step 3: Graph walk from ErrorHandler, depth=2
        → returns the full error handling subsystem

Result: 8 files, ~2000 tokens. Agent has complete error handling context
        without reading every file in the project.
```

### Cross-domain semantic matching (no embeddings)

```
Agent: "Find code that does something LIKE payments/stripe.ts but for Shopify"

Step 1: Index stripe.ts shape → extract interface:
        { createCharge, refund, listTransactions, webhookHandler }

Step 2: Search graph for symbols with similar method-name patterns:
        create*, refund*, list*, *Handler

Step 3: Rank matches by structural similarity:
        same number of methods, similar type signatures, similar call patterns

Result: "shopify_adapter.ts has 4/4 matching method patterns, confidence: high"
```

### Why this beats embeddings for code

| | Graph + metadata search | Embedding search |
|---|---|---|
| **Precision** | "This function IS called by your target" (fact) | "These chunks are 0.87 similar" (score) |
| **Explainability** | "Found via: name match → graph hop" | "Cosine similarity was high" (why?) |
| **Determinism** | Same query = same result, always | Varies by embedding model version |
| **Speed** | Sub-millisecond (SQLite index lookup) | 10-100ms (embedding + vector search) |
| **Dependencies** | None (pure graph metadata) | Embedding model (500MB+) |
| **False positives** | Low — structural relationships are facts | High — semantically similar ≠ relevant |

### Known limitations (honest)

- **Obfuscated/minified code** — names are meaningless. Embeddings fail here too.
- **Very poorly named code** — `doStuff()`, `handle()`, `process()`. But call graph still works.
- **Cross-language semantic matching** — "find the Python equivalent of this TypeScript class." v1 doesn't support this. If demand proves real, add optional local embedding model as a plugin in v2.
- **Natural language that doesn't map to any code concept** — "find the thing that makes users happy." Not solvable by any retrieval system.

### Implementation plan

Fuzzy discovery is a **Phase 2.5** addition (between retrieval and budget tracking):

1. `src/retrieval/fuzzy.ts` — symbol name search, file path search, type signature search
2. `src/retrieval/cluster.ts` — connected component discovery, neighborhood expansion
3. `src/retrieval/similarity.ts` — structural shape matching (method-name patterns)
4. Integrate into MCP tools: `search_graph` uses fuzzy as a fallback when exact anchor fails
5. New tool: `discover_subsystems` — returns the top-N architectural clusters
6. New tool: `find_similar` — structural similarity search across the graph

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

### Phase 2.5 — Fuzzy discovery layer (1-2 days)

1. Implement `src/retrieval/fuzzy.ts`:
   - Symbol name search (case-insensitive substring + camelCase splitting)
   - File path search (directory structure as domain signal)
   - Docstring/comment search (indexed alongside parent symbol in SQLite)
   - Type signature search (pattern match on `(ParamType) → ReturnType` shapes)
2. Implement `src/retrieval/cluster.ts`:
   - Connected component discovery (top-N by node count = major subsystems)
   - Neighborhood expansion (hop=1 from fuzzy match → bridge to graph walk)
3. Implement `src/retrieval/similarity.ts`:
   - Structural shape matching: extract method-name patterns + type signatures from a source symbol, find other symbols with similar patterns
4. Integration: `search_graph` tool uses fuzzy as a fallback when exact anchor resolution fails
5. New MCP tool: `discover_subsystems` — returns top-N architectural clusters with entry points
6. New MCP tool: `find_similar` — "find code shaped like X" without embeddings
7. Test: fuzzy query "auth" on a project with `AuthService` finds it in <1ms

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
| 2.5. Fuzzy discovery | 1-2 days | Phase 2 |
| 3. Budget tracking | 1 day | Phase 2.5 |
| 4. Agent auto-config | 1 day | Phase 1 |
| 5. Cross-repo | 1-2 days | Phase 2 |
| 6. Polish + ship | 1-2 days | all |
| **Total** | **8-13 days** | |

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
