# budget-aware-mcp

[![npm](https://img.shields.io/npm/v/budget-aware-mcp)](https://www.npmjs.com/package/budget-aware-mcp)
[![CI](https://github.com/Doorman11991/budget-aware-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/Doorman11991/budget-aware-mcp/actions)

Model-agnostic code memory MCP server. Budget-aware graph retrieval for AI agents — sub-millisecond queries, token budgeting, deterministic results. No embeddings, no vector DB, no API keys.

Built on [CodeGraphContext](https://github.com/CodeGraphContext/CodeGraphContext) for 155-language tree-sitter indexing. Replaces their retrieval layer with hop-based graph walks that respect token budgets.

## Why this exists

Every other code MCP tool dumps context at you — "here's 50k tokens of everything I found." Your agent's context overflows, it hallucinates, or it wastes money processing irrelevant code.

**budget-aware-mcp** is different: the agent says "give me context for `AuthService`, max 8000 tokens" and gets exactly 8000 tokens of the most structurally-relevant code, walking outward from the anchor symbol hop by hop until the budget is hit. No waste. No overflow.

## Install

```bash
npm install -g budget-aware-mcp
budget-aware-mcp install
```

Auto-detects and configures: **Kiro, Claude Code, Cursor, VS Code, Windsurf, Zed, Codex CLI, Gemini CLI, Aider, OpenCode**.

Or from source:

```bash
git clone https://github.com/Doorman11991/budget-aware-mcp.git
cd budget-aware-mcp
npm install && npm run build
budget-aware-mcp install
```

## Performance

```
┌───────────────────────────────┬─────────┬─────────┐
│ Operation                     │ Avg(ms) │ P95(ms) │
├───────────────────────────────┼─────────┼─────────┤
│ Graph walk depth=2            │    0.07 │    0.11 │
│ Fuzzy search                  │    0.25 │    0.64 │
│ Explain symbol                │    8.00 │   12.00 │
│ Scope check                   │    0.04 │    0.48 │
│ Discover architecture         │    1.41 │    2.33 │
│ Index 108 files (41k LOC)     │  529.00 │  600.00 │
└───────────────────────────────┴─────────┴─────────┘
```

Queries are sub-millisecond once the server is warm. Semantic cache makes repeated/similar queries instant.

## Tools (22)

### Index
| Tool | Description |
|------|-------------|
| `index_repo` | Parse files, build symbol graph, persist to SQLite. 155 languages via tree-sitter. |
| `list_repos` | List all indexed repositories with stats |
| `get_repo_stats` | Detailed stats: symbol kinds, languages, edge types, top connected symbols |

### Retrieval
| Tool | Description |
|------|-------------|
| `graph_walk` | BFS from anchor symbol. Budget-aware, deterministic, hop-limited. |
| `search_graph` | Natural language → fuzzy match → graph walk. Semantic cache enabled. |
| `check_scope` | "Is this task feasible?" — answers without calling any LLM. |
| `trace_call_path` | Shortest path between two symbols via call/import edges. |
| `analyze_impact` | Blast radius: what breaks if these files change? |

### Discovery
| Tool | Description |
|------|-------------|
| `fuzzy_find_symbol` | camelCase/snake_case splitting search. Semantic cache enabled. |
| `find_by_path` | Search files by path pattern |
| `find_by_signature` | "Something that takes User and returns Token" |
| `discover_subsystems` | Architecture overview: clusters, hotspots, entry points, languages |
| `find_similar` | Structural similarity without embeddings |
| `expand_neighborhood` | Hop=1 from a symbol — bridge into the full graph |

### Context
| Tool | Description |
|------|-------------|
| `get_file_context` | File + all its dependencies, within token budget |
| `explain_symbol` | One-shot: signature, callers, callees, location, connectivity |
| `suggest_files` | "What files should I look at for this task?" — ranked by relevance |
| `find_dead_code` | Symbols with zero inbound edges (nothing calls them) |
| `get_code_snippet` | Read actual source code with line numbers |
| `search_code` | Full-text regex search across file contents with context |

### Management
| Tool | Description |
|------|-------------|
| `delete_project` | Remove an indexed repository from the graph |
| `get_session_stats` | Cumulative token accounting across all queries |

## Key Features (unique to budget-aware-mcp)

These features don't exist in [CodeGraphContext](https://github.com/CodeGraphContext/CodeGraphContext) or any other code MCP server. CodeGraphContext is a **required dependency** for full 155-language tree-sitter indexing — we build our retrieval layer on top of their index.

---

### 1. Token Budget Per Query

**Problem:** Other tools return everything they find. An agent asks "what's relevant to auth?" and gets 50,000 tokens of code. Most of it is irrelevant. The agent's context window overflows or it wastes money processing junk.

**Our solution:** Every query has a `max_tokens` parameter. The graph walk starts at your anchor symbol, walks outward along real call/import edges, and stops adding context the moment the budget is hit.

```
Agent: graph_walk("AuthService", hop_depth=2, max_tokens=8000)

Result: 20 symbols across 12 files, exactly 7,998 tokens.
        Stopped at hop 2 because adding the next symbol would exceed 8000.
```

The agent asked for 8000. It got 8000. Not 50,000. Not 3,000. Exactly what it asked for, filled with the most structurally-connected code first.

---

### 2. Token Accounting Per Session

**Problem:** Agents have no idea how much context they've consumed across a conversation. After 10 queries they might have blown through 100k tokens without realizing it.

**Our solution:** Every query is tracked. The agent can ask at any time: "how much have I spent?"

```
Agent: get_session_stats()

Result:
  total_queries: 8
  total_tokens_returned: 24,500
  repos_indexed: 2
  coverage: 12% of codebase explored
```

This lets agents make smart decisions: "I've already seen 24k tokens — do I need more context or should I start generating?" Instead of blindly reading more files, the agent knows its budget.

---

### 3. Scope/Feasibility Check

**Problem:** An agent decides to "refactor the PaymentProcessor class." It generates 200 lines of code referencing `PaymentProcessor`, `StripeAdapter`, and `WebhookHandler`. None of those exist in the codebase. The agent hallucinated the entire thing.

**Our solution:** Before generating code, the agent asks "is this task doable?"

```
Agent: check_scope("refactor PaymentProcessor to support Stripe webhooks")

Result:
  feasibility: "unknown"
  found_symbols: []
  missing_symbols: ["PaymentProcessor", "Stripe", "webhook"]
  confidence: 0.1

→ Agent knows: these symbols don't exist. Don't generate code for them.
```

vs.

```
Agent: check_scope("refactor the Emitter class to support multiple targets")

Result:
  feasibility: "full"
  found_symbols: ["Emitter"]
  confidence: 0.95

→ Agent knows: Emitter exists, go ahead.
```

Zero LLM calls. Pure graph lookup. Prevents wasted generation attempts.

---

### 4. Blast-Radius Impact Analysis

**Problem:** Other tools detect "these files changed" (git diff). That's not useful for an agent planning a refactor — it needs to know "if I change THIS, what ELSE breaks?"

**Our solution:** Given a list of changed files, walks the dependency graph backwards to find everything that depends on the changed code.

```
Agent: analyze_impact(changed_files=["auth.ts"], hop_depth=2)

Result:
  changed_symbols: ["AuthService", "validateToken", "refreshSession"]
  blast_radius: 14 symbols across 8 files depend on these
  affected_files: ["routes/user.ts", "middleware/auth.ts", "services/payment.ts", ...]
```

The agent now knows: "If I change auth.ts, I might break 8 other files. Let me check those too before I submit this PR."

---

### 5. Deterministic Ordering

**Problem:** BM25 search scores change based on index state, document frequency, and other factors. The same query returns different results on different days. You can't reproduce a bug, you can't write reliable tests, you can't trust the output.

**Our solution:** Same query, same result. Every time. No exceptions.

How: within each hop level of the graph walk, symbols are sorted alphabetically by FQN. The walk is BFS (breadth-first), so hop 0 is always the anchor, hop 1 is always its direct connections sorted A-Z, hop 2 is always THEIR connections sorted A-Z.

```
Run 1: graph_walk("Emitter", 2, 8000) → [Emitter, emitBudget, emitCache, emitCheckpoint, ...]
Run 2: graph_walk("Emitter", 2, 8000) → [Emitter, emitBudget, emitCache, emitCheckpoint, ...]
Run 3: graph_walk("Emitter", 2, 8000) → [Emitter, emitBudget, emitCache, emitCheckpoint, ...]
```

Always the same. Debuggable. Reproducible. Testable.

---

### 6. Multi-Hop Walk With Budget Cutoff

**Problem:** A flat search returns "here are 20 results ranked by keyword relevance." But code isn't flat — it's a graph. `AuthService` calls `TokenValidator` which calls `CryptoUtils`. You need to understand the CHAIN, not just individual matches.

**Our solution:** Start at a symbol. Walk outward along actual call/import/inheritance edges. Each "hop" adds the next layer of connected code. Stop when the budget is full.

```
Hop 0: AuthService (the thing you asked about)
Hop 1: validateToken, refreshSession, hashPassword (things AuthService calls)
Hop 2: CryptoUtils, SessionStore, TokenBlacklist (things THOSE call)
        ↑ stopped here — budget hit at 8000 tokens
```

This gives the agent a **connected subgraph** — not a flat list. It understands the call chain, the dependencies, the architecture. In 8000 tokens instead of reading 12 files manually (50,000+ tokens).

---

## Dependency: CodeGraphContext

budget-aware-mcp uses [CodeGraphContext](https://github.com/CodeGraphContext/CodeGraphContext) as its indexing engine. When installed, it provides:
- 155-language tree-sitter parsing
- 4000+ edges per project (calls, imports, inheritance, usage)
- Incremental re-indexing
- 3D graph visualization (localhost:9749)

Install it for best results:
```bash
# Windows
powershell -c "irm https://raw.githubusercontent.com/CodeGraphContext/CodeGraphContext/main/install.ps1 | iex"

# macOS/Linux
curl -fsSL https://raw.githubusercontent.com/CodeGraphContext/CodeGraphContext/main/install.sh | bash
```

Without CodeGraphContext, budget-aware-mcp falls back to its built-in regex parser (~30 languages, 86% edge coverage). Everything still works — just fewer edges to walk.
- **Entry points**: functions with high out-degree but low in-degree
- **Language breakdown**: files and LOC per language

## How it differs from CodeGraphContext

| | CodeGraphContext | budget-aware-mcp |
|---|---|---|
| **Retrieval** | BM25 keyword search | Hop-based graph walk with token budget |
| **Token control** | None — returns everything | Agent specifies max, retrieval stops there |
| **Determinism** | BM25 scores vary | Same query = same result, always |
| **Caching** | None | Semantic cache (similar queries → instant) |
| **Scope check** | Not available | "Is this task feasible?" |
| **Explain symbol** | Not available | One call: signature + callers + callees |
| **File context** | Not available | File + all dependencies in one shot |
| **Suggest files** | Not available | Task → ranked file list |
| **Dead code** | Not available | Zero-inbound-edge detection |
| **Session tracking** | Not available | Cumulative token spend |
| **Code reading** | `get_code_snippet` | `get_code_snippet` + `search_code` |
| **Architecture** | Packages, layers, routes | Clusters, hotspots, entry points |
| **Startup** | ~15ms (native C) | ~200ms (Node.js) — 0.07ms per query once warm |

## Architecture

```
AI Agent (any MCP client)
  ↓ stdio (JSON-RPC 2.0)
budget-aware-mcp
  ├── Semantic Cache (trigram similarity, 5min TTL)
  ├── Retrieval (graph_walk, fuzzy, scope_check, cluster, similarity)
  ├── Context (get_file_context, explain_symbol, suggest_files)
  ├── Code Access (get_code_snippet, search_code)
  ├── CodeGraphContext .db (when installed — 155 langs, 4000+ edges)
  ├── Built-in parser (regex + call resolution — 30 langs, 3500+ edges)
  └── SQLite (.code-graph/graph.db)
```

## CLI

```bash
budget-aware-mcp              # Run MCP server on stdio
budget-aware-mcp install      # Auto-detect agents, configure MCP
budget-aware-mcp uninstall    # Remove MCP config from all agents
budget-aware-mcp --version    # Show version
budget-aware-mcp --help       # Show help
```

## Development

```bash
npm test              # Run 19-test suite
npm run bench         # In-process latency benchmarks
npm run bench:compare # Side-by-side with CodeGraphContext
```

## License

MIT
