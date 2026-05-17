#!/usr/bin/env node
// code-graph-mcp — Model-Agnostic Code Memory MCP Server
// Generated from code_graph_mcp.marrow, then wired to @modelcontextprotocol/sdk.
//
// Provides graph-based code retrieval for any AI agent over MCP.
// No embeddings, no vector DB, no API keys.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { db } from "./db.js";
import { GraphWalker } from "./retrieval/graph_walk.js";
import { FuzzyFinder } from "./retrieval/fuzzy.js";
import { ScopeChecker } from "./retrieval/scope_check.js";
import { ClusterDiscovery } from "./retrieval/cluster.js";
import { SimilarityFinder } from "./retrieval/similarity.js";
import { SessionTracker } from "./tracking/session.js";
import { Indexer } from "./index/indexer.js";
import { CbmStore } from "./index/cbm_store.js";

const server = new Server(
  { name: "budget-aware-mcp", version: "0.2.0" },
  { capabilities: { tools: {} } }
);

const walker = new GraphWalker(db);
const fuzzy = new FuzzyFinder(db);
const scopeChecker = new ScopeChecker(db);
const clusters = new ClusterDiscovery(db);
const similarity = new SimilarityFinder(db);
const sessions = new SessionTracker(db);
const indexer = new Indexer(db);

// ═══════════════════════════════════════════════════════════════════════════════
// TOOL DEFINITIONS
// ═══════════════════════════════════════════════════════════════════════════════

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    // ─── Index Layer ─────────────────────────────────────────────────────
    {
      name: "index_repo",
      description: "Index a repository: parse all files with tree-sitter, extract symbols and edges, persist to SQLite.",
      inputSchema: {
        type: "object" as const,
        properties: {
          path: { type: "string", description: "Absolute path to the repository root" },
          name: { type: "string", description: "Human-readable name for this repo" },
        },
        required: ["path"],
      },
    },
    {
      name: "list_repos",
      description: "List all indexed repositories with stats (file count, symbol count, LOC, languages).",
      inputSchema: { type: "object" as const, properties: {} },
    },
    {
      name: "get_repo_stats",
      description: "Get detailed statistics for a specific indexed repository.",
      inputSchema: {
        type: "object" as const,
        properties: {
          repo_name: { type: "string", description: "Name of the repository" },
        },
        required: ["repo_name"],
      },
    },
    // ─── Retrieval Layer ─────────────────────────────────────────────────
    {
      name: "graph_walk",
      description: "BFS graph walk from anchor symbol(s). Collects symbols along import/call/inheritance edges until token budget is hit. Deterministic: same query always returns same result.",
      inputSchema: {
        type: "object" as const,
        properties: {
          anchor: { type: "string", description: "Symbol name or FQN to start walking from" },
          hop_depth: { type: "number", description: "Max hops from anchor (1-10). Default: 2", default: 2 },
          max_tokens: { type: "number", description: "Token budget. Stop adding context when this is exceeded. Default: 8000", default: 8000 },
        },
        required: ["anchor"],
      },
    },
    {
      name: "search_graph",
      description: "Search the code graph with a query string. Resolves to symbols via fuzzy match, then walks the graph from the best match. Falls back to fuzzy discovery when exact anchor fails.",
      inputSchema: {
        type: "object" as const,
        properties: {
          query: { type: "string", description: "Natural language or symbol name query" },
          hop_depth: { type: "number", description: "Max hops from match (1-10). Default: 2", default: 2 },
          max_tokens: { type: "number", description: "Token budget. Default: 8000", default: 8000 },
        },
        required: ["query"],
      },
    },
    {
      name: "check_scope",
      description: "Feasibility check: 'Is this task achievable with the available context?' Returns which symbols are present/missing for the described task. No LLM involved.",
      inputSchema: {
        type: "object" as const,
        properties: {
          task_description: { type: "string", description: "Description of the task you want to accomplish" },
          available_symbols: { type: "array", items: { type: "string" }, description: "Optional: symbols you already have in context" },
        },
        required: ["task_description"],
      },
    },
    {
      name: "trace_call_path",
      description: "Find the shortest call/import path between two symbols in the graph.",
      inputSchema: {
        type: "object" as const,
        properties: {
          from_symbol: { type: "string", description: "Source symbol name or FQN" },
          to_symbol: { type: "string", description: "Target symbol name or FQN" },
          max_hops: { type: "number", description: "Maximum path length (1-20). Default: 10", default: 10 },
        },
        required: ["from_symbol", "to_symbol"],
      },
    },
    {
      name: "analyze_impact",
      description: "Impact analysis: given changed files, find the blast radius in the graph — what else is affected.",
      inputSchema: {
        type: "object" as const,
        properties: {
          changed_files: { type: "array", items: { type: "string" }, description: "File paths that changed (relative to repo root)" },
          hop_depth: { type: "number", description: "How many hops to trace from changed symbols (1-5). Default: 2", default: 2 },
        },
        required: ["changed_files"],
      },
    },
    // ─── Fuzzy Discovery ─────────────────────────────────────────────────
    {
      name: "fuzzy_find_symbol",
      description: "Fuzzy search for symbols by name. Splits camelCase/snake_case for broader matching. Use when you don't know the exact name.",
      inputSchema: {
        type: "object" as const,
        properties: {
          query: { type: "string", description: "Partial symbol name or keyword" },
          max_results: { type: "number", description: "Max results (1-100). Default: 20", default: 20 },
        },
        required: ["query"],
      },
    },
    {
      name: "find_by_path",
      description: "Search files by path pattern. Match against directory structure as a domain signal.",
      inputSchema: {
        type: "object" as const,
        properties: {
          path_pattern: { type: "string", description: "Path substring or glob pattern to match" },
          max_results: { type: "number", description: "Max results. Default: 20", default: 20 },
        },
        required: ["path_pattern"],
      },
    },
    {
      name: "find_by_signature",
      description: "Search for functions by type signature shape: 'something that takes X and returns Y'.",
      inputSchema: {
        type: "object" as const,
        properties: {
          param_types: { type: "array", items: { type: "string" }, description: "Parameter type names to look for" },
          return_type: { type: "string", description: "Expected return type name" },
        },
        required: ["param_types"],
      },
    },
    {
      name: "discover_subsystems",
      description: "Discover major architectural subsystems: top-N connected components by node count. Returns entry points for each cluster.",
      inputSchema: {
        type: "object" as const,
        properties: {
          max_clusters: { type: "number", description: "Number of top clusters to return (1-50). Default: 5", default: 5 },
        },
      },
    },
    {
      name: "find_similar",
      description: "Structural similarity: find code shaped like a given symbol — matches by method-name patterns and type signatures. No embeddings.",
      inputSchema: {
        type: "object" as const,
        properties: {
          source_symbol: { type: "string", description: "Symbol to find similar structures for" },
          max_results: { type: "number", description: "Max results (1-50). Default: 10", default: 10 },
        },
        required: ["source_symbol"],
      },
    },
    {
      name: "expand_neighborhood",
      description: "Neighborhood expansion: hop=1 from a symbol. Bridge from a fuzzy match into the full graph.",
      inputSchema: {
        type: "object" as const,
        properties: {
          symbol_fqn: { type: "string", description: "Fully qualified name of the symbol" },
          max_tokens: { type: "number", description: "Token budget. Default: 4000", default: 4000 },
        },
        required: ["symbol_fqn"],
      },
    },
    // ─── Budget & Session ────────────────────────────────────────────────
    {
      name: "get_session_stats",
      description: "Get session-level token accounting: total queries, tokens returned, tokens saved vs full file reads.",
      inputSchema: {
        type: "object" as const,
        properties: {
          session_id: { type: "string", description: "Session identifier. Default: 'default'", default: "default" },
        },
      },
    },
  ],
}));

// ═══════════════════════════════════════════════════════════════════════════════
// TOOL HANDLERS
// ═══════════════════════════════════════════════════════════════════════════════

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const startMs = performance.now();

  try {
    let result: any;

    // Try to find a CBM database for richer graph data (4000+ edges vs 100)
    const cbmStore = new CbmStore();
    const cbmProjects = cbmStore.listProjects();
    // Use first available CBM db as default (most tools don't specify project)
    const defaultCbmDb = cbmProjects.length > 0 ? cbmStore.findDb(cbmProjects[0].name) : null;

    switch (name) {
      // ─── Index Layer ───────────────────────────────────────────────────
      case "index_repo": {
        const repoPath = args?.path as string;
        const repoName = (args?.name as string) || repoPath.split(/[/\\]/).pop() || "unnamed";
        result = await indexer.indexRepo(repoPath, repoName);
        break;
      }
      case "list_repos": {
        // Merge our repos + CBM repos
        const ours = await indexer.listRepos();
        const cbmRepos = cbmProjects.map(p => ({
          name: p.name, root_path: p.root_path, source: "codebase-memory-mcp (tree-sitter)",
        }));
        result = { ...ours, cbm_repos: cbmRepos, total_cbm: cbmRepos.length };
        break;
      }
      case "get_repo_stats": {
        result = await indexer.getRepoStats(args?.repo_name as string);
        break;
      }
      // ─── Retrieval Layer ───────────────────────────────────────────────
      case "graph_walk": {
        const anchor = args?.anchor as string;
        const hopDepth = Math.min(10, Math.max(1, (args?.hop_depth as number) || 2));
        const maxTokens = Math.max(100, (args?.max_tokens as number) || 8000);
        // Try CBM store first (has 30x more edges)
        if (defaultCbmDb) {
          result = cbmStore.graphWalk(defaultCbmDb, anchor, hopDepth, maxTokens);
          if (result.symbols.length > 0) break;
        }
        // Fallback to our own DB
        result = await walker.walk(anchor, hopDepth, maxTokens);
        break;
      }
      case "search_graph": {
        const query = args?.query as string;
        const hopDepth = Math.min(10, Math.max(1, (args?.hop_depth as number) || 2));
        const maxTokens = Math.max(100, (args?.max_tokens as number) || 8000);
        if (defaultCbmDb) {
          // Fuzzy find on CBM, then walk
          const matches = cbmStore.fuzzyFind(defaultCbmDb, query, 5);
          if (matches.length > 0) {
            result = cbmStore.graphWalk(defaultCbmDb, matches[0].name, hopDepth, maxTokens);
            break;
          }
        }
        // Fallback
        const matches = await fuzzy.findSymbol(query, 5);
        if (matches.length === 0) {
          result = { files: [], symbols: [], _meta: { tokens_returned: 0, message: "No matching symbols found" } };
        } else {
          result = await walker.walk(matches[0].fqn, hopDepth, maxTokens);
        }
        break;
      }
      case "check_scope": {
        result = await scopeChecker.check(
          args?.task_description as string,
          (args?.available_symbols as string[]) || []
        );
        break;
      }
      case "trace_call_path": {
        if (defaultCbmDb) {
          result = cbmStore.tracePath(
            defaultCbmDb,
            args?.from_symbol as string,
            args?.to_symbol as string,
            Math.min(20, Math.max(1, (args?.max_hops as number) || 10))
          );
          if (result.found) break;
        }
        result = await walker.tracePath(
          args?.from_symbol as string,
          args?.to_symbol as string,
          Math.min(20, Math.max(1, (args?.max_hops as number) || 10))
        );
        break;
      }
      case "analyze_impact": {
        if (defaultCbmDb) {
          result = cbmStore.analyzeImpact(
            defaultCbmDb,
            args?.changed_files as string[],
            Math.min(5, Math.max(1, (args?.hop_depth as number) || 2))
          );
          if (result.blast_radius > 0) break;
        }
        result = await walker.analyzeImpact(
          args?.changed_files as string[],
          Math.min(5, Math.max(1, (args?.hop_depth as number) || 2))
        );
        break;
      }
      // ─── Fuzzy Discovery ───────────────────────────────────────────────
      case "fuzzy_find_symbol": {
        const q = args?.query as string;
        const max = Math.min(100, Math.max(1, (args?.max_results as number) || 20));
        if (defaultCbmDb) {
          result = cbmStore.fuzzyFind(defaultCbmDb, q, max);
          if (result.length > 0) break;
        }
        result = await fuzzy.findSymbol(q, max);
        break;
      }
      case "find_by_path": {
        result = await fuzzy.findByPath(
          args?.path_pattern as string,
          Math.min(100, Math.max(1, (args?.max_results as number) || 20))
        );
        break;
      }
      case "find_by_signature": {
        result = await fuzzy.findBySignature(
          args?.param_types as string[],
          (args?.return_type as string) || ""
        );
        break;
      }
      case "discover_subsystems": {
        if (defaultCbmDb) {
          result = cbmStore.discoverSubsystems(defaultCbmDb, Math.min(50, Math.max(1, (args?.max_clusters as number) || 5)));
          if (result.clusters.length > 0) break;
        }
        result = await clusters.discover(
          Math.min(50, Math.max(1, (args?.max_clusters as number) || 5))
        );
        break;
      }
      case "find_similar": {
        result = await similarity.find(
          args?.source_symbol as string,
          Math.min(50, Math.max(1, (args?.max_results as number) || 10))
        );
        break;
      }
      case "expand_neighborhood": {
        result = await walker.walk(
          args?.symbol_fqn as string,
          1, // hop_depth = 1 for neighborhood
          Math.max(100, (args?.max_tokens as number) || 4000)
        );
        break;
      }
      // ─── Budget & Session ──────────────────────────────────────────────
      case "get_session_stats": {
        result = sessions.getStats((args?.session_id as string) || "default");
        break;
      }
      default:
        return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
    }

    const queryMs = performance.now() - startMs;

    // Track session stats
    const tokenEstimate = JSON.stringify(result).length / 4;
    sessions.recordQuery((args as any)?.session_id || "default", tokenEstimate, queryMs);

    // Attach _meta to every response
    const meta = {
      query_ms: Math.round(queryMs * 100) / 100,
      tokens_returned: Math.round(tokenEstimate),
    };

    return {
      content: [{
        type: "text",
        text: JSON.stringify({ ...result, _meta: meta }, null, 2),
      }],
    };
  } catch (error: any) {
    return {
      content: [{ type: "text", text: `Error: ${error.message}` }],
      isError: true,
    };
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// START
// ═══════════════════════════════════════════════════════════════════════════════

async function main() {
  try {
    // Initialize database
    db.initialize();
  } catch (e: any) {
    process.stderr.write(`[code-graph-mcp] DB init failed: ${e.message}\n`);
    process.exit(1);
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
