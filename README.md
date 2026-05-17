# budget-aware-mcp

[![npm](https://img.shields.io/npm/v/budget-aware-mcp)](https://www.npmjs.com/package/budget-aware-mcp)

Model-agnostic code memory MCP server. Budget-aware graph retrieval for AI agents — sub-millisecond queries, token budgeting, deterministic results. No embeddings, no vector DB, no API keys.

Built on [CodeGraphContext](https://github.com/CodeGraphContext/CodeGraphContext) for 155-language tree-sitter indexing. Replaces their retrieval layer with hop-based graph walks that respect token budgets.

## What it does

Any AI agent (Claude, Cursor, Kiro, Aider, Codex, Gemini CLI, etc.) gets structured codebase memory through MCP — instead of reading files manually or wasting tokens on irrelevant context, the agent says "give me context for `Emitter`, max 8000 tokens" and gets exactly that.

## Install

```bash
npm install -g budget-aware-mcp
budget-aware-mcp install
```

Auto-detects and configures: Kiro, Claude Code, Cursor, VS Code, Windsurf, Zed, Codex CLI, Gemini CLI, Aider, OpenCode.

Or from source:

```bash
git clone https://github.com/Doorman11991/budget-aware-mcp.git
cd budget-aware-mcp
npm install
npm run build
```

For 155-language tree-sitter support, also install [CodeGraphContext](https://github.com/CodeGraphContext/CodeGraphContext):
```bash
# Windows
powershell -c "irm https://raw.githubusercontent.com/CodeGraphContext/CodeGraphContext/main/install.ps1 | iex"

# macOS/Linux
curl -fsSL https://raw.githubusercontent.com/CodeGraphContext/CodeGraphContext/main/install.sh | bash
```

## Performance

```
┌───────────────────────────────┬─────────┬─────────┐
│ Operation                     │ Avg(ms) │ P95(ms) │
├───────────────────────────────┼─────────┼─────────┤
│ Fuzzy search                  │    0.25 │    0.64 │
│ Graph walk depth=2            │    0.07 │    0.11 │
│ Scope check                   │    0.04 │    0.48 │
│ Explain symbol                │    8.00 │   12.00 │
│ Discover subsystems           │    1.41 │    2.33 │
│ Index 108 files (41k LOC)     │  529.00 │  600.00 │
└───────────────────────────────┴─────────┴─────────┘
```

## Tools (19)

### Index Layer
| Tool | Description |
|------|-------------|
| `index_repo` | Parse files, build symbol graph, persist to SQLite |
| `list_repos` | List all indexed repositories with stats |
| `get_repo_stats` | Detailed stats for a specific repo |

### Retrieval Layer
| Tool | Description |
|------|-------------|
| `graph_walk` | BFS from anchor symbol, budget-aware, deterministic |
| `search_graph` | Natural language → fuzzy match → graph walk |
| `check_scope` | "Is this task feasible?" — no LLM, pure graph heuristic |
| `trace_call_path` | Shortest path between two symbols |
| `analyze_impact` | Blast radius from changed files |

### Fuzzy Discovery
| Tool | Description |
|------|-------------|
| `fuzzy_find_symbol` | camelCase-splitting symbol search |
| `find_by_path` | Search by file path pattern |
| `find_by_signature` | "Something that takes X and returns Y" |
| `discover_subsystems` | Top-N architectural clusters |
| `find_similar` | Structural similarity without embeddings |
| `expand_neighborhood` | Hop=1 from a symbol |

### Context Tools
| Tool | Description |
|------|-------------|
| `get_file_context` | File + all its dependencies within token budget |
| `explain_symbol` | One-shot: signature, callers, callees, location, connectivity |
| `suggest_files` | "What files should I look at for this task?" |
| `find_dead_code` | Symbols with zero inbound edges (nothing calls them) |

### Session
| Tool | Description |
|------|-------------|
| `get_session_stats` | Cumulative token accounting |

## How it differs from CodeGraphContext

| | CodeGraphContext | budget-aware-mcp |
|---|---|---|
| **Retrieval** | BM25 keyword search | Hop-based graph walk with token budget |
| **Token control** | None — returns everything | Agent specifies max tokens, retrieval stops there |
| **Determinism** | BM25 scores vary | Same query = same result, always |
| **Scope check** | Not available | "Is this task feasible given the codebase?" |
| **Impact analysis** | Git diff detection | Blast radius mapping (what DEPENDS on changed code) |
| **Explain symbol** | Not available | One call: signature + callers + callees + location |
| **File context** | Not available | File + all dependencies in one shot |
| **Suggest files** | Not available | "What files for this task?" ranked by connectivity |
| **Dead code** | Not available | Zero-inbound-edge detection |
| **Session tracking** | Not available | Cumulative token spend across queries |
| **Edge resolution** | 4117 edges (tree-sitter) | 3563 edges (regex + call resolution, no external deps) |
| **Startup** | ~15ms (native C) | ~200ms (Node.js) — but 0.07ms per query once warm |

## Architecture

```
AI Agent (any MCP client)
  ↓ stdio (JSON-RPC 2.0)
budget-aware-mcp (this project)
  ├── Retrieval: graph_walk, fuzzy, scope_check, cluster, similarity
  ├── Context: get_file_context, explain_symbol, suggest_files, find_dead_code
  ├── Reads: CodeGraphContext .db files (when installed)
  ├── Built-in: regex parser + call resolution (~30 languages, 86% edge coverage)
  └── Storage: SQLite (.code-graph/graph.db)
```

## CLI

```bash
budget-aware-mcp              # Run MCP server on stdio (default)
budget-aware-mcp install      # Auto-detect agents, configure MCP
budget-aware-mcp uninstall    # Remove MCP config from all agents
budget-aware-mcp --help       # Show help
budget-aware-mcp --version    # Show version
```

## Benchmarks

```bash
npm run bench           # In-process latency (sub-millisecond)
npm run bench:compare   # Side-by-side with CodeGraphContext
```

## License

MIT
