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

## Key Features

### Token Budget Enforcement
Every retrieval tool respects a `max_tokens` parameter. The graph walk stops adding context the moment the budget is hit — the agent never gets more than it asked for.

### Semantic Cache
Similar queries hit cache instantly:
```
"auth"           → 0.25ms (DB query)
"authentication" → 0.01ms (cache hit, similarity: 0.82)
```
Trigram-based Jaccard similarity. Threshold: 0.7. TTL: 5 minutes. Zero dependencies.

### 155-Language Support
When [CodeGraphContext](https://github.com/CodeGraphContext/CodeGraphContext) is installed, indexing uses tree-sitter for full-fidelity parsing. Without it, the built-in regex parser covers ~30 languages at 86% edge coverage.

### Deterministic Results
Same query always returns same result. Alphabetical ordering within each hop level. No scores that drift. Reproducible, debuggable.

### Scope Check
Before an agent tries to write code, it asks "do the symbols I need exist?" Pure graph lookup — no LLM. Prevents wasted generation on things that don't exist in the codebase.

### Architecture Discovery
`discover_subsystems` returns:
- **Clusters**: major code areas grouped by directory
- **Hotspots**: most-connected symbols (fan-in + fan-out)
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
