# code-graph-mcp

Model-agnostic code memory MCP server. Budget-aware graph retrieval for AI agents — sub-millisecond queries, token budgeting, deterministic results. No embeddings, no vector DB, no API keys.

Built on [CodeGraphContext](https://github.com/CodeGraphContext/CodeGraphContext) for 155-language tree-sitter indexing. Replaces their retrieval layer with hop-based graph walks that respect token budgets.

## What it does

Any AI agent (Claude, Cursor, Kiro, Aider, Codex, Gemini CLI, etc.) gets structured codebase memory through MCP — instead of reading files manually or wasting tokens on irrelevant context, the agent says "give me context for `Emitter`, max 8000 tokens" and gets exactly that.

## Performance

```
┌───────────────────────────────┬─────────┬─────────┐
│ Operation                     │ Avg(ms) │ P95(ms) │
├───────────────────────────────┼─────────┼─────────┤
│ Fuzzy search                  │    0.25 │    0.64 │
│ Graph walk depth=2            │    0.07 │    0.11 │
│ Scope check                   │    0.04 │    0.48 │
│ Discover subsystems           │    1.41 │    2.33 │
│ Find similar                  │    0.09 │    0.38 │
│ Index 108 files (41k LOC)     │   84.50 │  101.34 │
└───────────────────────────────┴─────────┴─────────┘
```

## Install

```bash
git clone https://github.com/YOUR_USERNAME/code-graph-mcp.git
cd code-graph-mcp
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

## Configure for your AI agent

Add to your MCP config:

```json
{
  "mcpServers": {
    "code-graph": {
      "command": "node",
      "args": ["/path/to/code-graph-mcp/dist/index.js"]
    }
  }
}
```

Config locations:
- **Kiro**: `.kiro/settings/mcp.json`
- **Claude Code**: `.claude/mcp.json`
- **Cursor**: `.cursor/mcp.json`

## Tools (15)

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

### Session Tracking
| Tool | Description |
|------|-------------|
| `get_session_stats` | Cumulative token accounting |

## How it differs from CodeGraphContext

| | CodeGraphContext | code-graph-mcp |
|---|---|---|
| **Retrieval** | BM25 keyword search | Hop-based graph walk with token budget |
| **Token control** | None — returns everything | Agent specifies max tokens, retrieval stops there |
| **Determinism** | BM25 scores vary | Same query = same result, always |
| **Scope check** | Not available | "Is this task feasible given the codebase?" |
| **Impact analysis** | Git diff detection | Blast radius mapping (what DEPENDS on changed code) |
| **Session tracking** | Not available | Cumulative token spend across queries |
| **Startup** | ~15ms (native C) | ~200ms (Node.js) — but 0.07ms per query once warm |

## Architecture

```
AI Agent (any MCP client)
  ↓ stdio (JSON-RPC 2.0)
code-graph-mcp (this project)
  ├── Retrieval: graph_walk, fuzzy, scope_check, cluster, similarity
  ├── Reads: CodeGraphContext .db files (1500+ nodes, 4000+ edges)
  ├── Fallback: built-in regex parser (~30 languages)
  └── Storage: SQLite (.code-graph/graph.db)
```

## Benchmarks

```bash
npm run bench           # In-process latency (sub-millisecond)
npm run bench:compare   # Side-by-side with CodeGraphContext
```

## License

MIT
