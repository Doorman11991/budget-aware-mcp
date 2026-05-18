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
import { SemanticCache } from "./retrieval/semantic_cache.js";
import { MemoryStore } from "./memory/store.js";

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
const queryCache = new SemanticCache(0.7, 200, 300_000); // 5 min TTL
const memory = new MemoryStore();

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
    // ─── Context Tools ───────────────────────────────────────────────────
    {
      name: "get_file_context",
      description: "Read a file with its full dependency context: the file's symbols + everything they import/call, within a token budget. Like reading a file but you also get everything it depends on.",
      inputSchema: {
        type: "object" as const,
        properties: {
          file_path: { type: "string", description: "File path (relative to repo root or absolute)" },
          max_tokens: { type: "number", description: "Token budget for all context. Default: 8000", default: 8000 },
          include_callers: { type: "boolean", description: "Also include things that call INTO this file. Default: false", default: false },
        },
        required: ["file_path"],
      },
    },
    {
      name: "explain_symbol",
      description: "One-shot full explanation of a symbol: signature, location, what it calls, what calls it, which file, and where it fits in the architecture. Saves 3-4 separate tool calls.",
      inputSchema: {
        type: "object" as const,
        properties: {
          symbol: { type: "string", description: "Symbol name or FQN" },
        },
        required: ["symbol"],
      },
    },
    {
      name: "suggest_files",
      description: "Given a task description, suggest which files are most relevant to look at. Ranks by symbol name matches + edge connectivity.",
      inputSchema: {
        type: "object" as const,
        properties: {
          task: { type: "string", description: "What you're trying to do (e.g. 'add rate limiting')" },
          max_results: { type: "number", description: "Max files to suggest. Default: 10", default: 10 },
        },
        required: ["task"],
      },
    },
    {
      name: "find_dead_code",
      description: "Find symbols with zero inbound edges — functions/classes that nothing calls. Useful for cleanup.",
      inputSchema: {
        type: "object" as const,
        properties: {
          max_results: { type: "number", description: "Max results. Default: 20", default: 20 },
        },
      },
    },
    // ─── Code Access ─────────────────────────────────────────────────────
    {
      name: "get_code_snippet",
      description: "Read the actual source code of a symbol or file. Returns the raw code with line numbers. Essential for understanding implementation details.",
      inputSchema: {
        type: "object" as const,
        properties: {
          symbol: { type: "string", description: "Symbol name to get code for. If not found, treats as file path." },
          file_path: { type: "string", description: "File path (relative to repo root)" },
          start_line: { type: "number", description: "Start line (optional, defaults to symbol start)" },
          end_line: { type: "number", description: "End line (optional, defaults to symbol end)" },
          max_lines: { type: "number", description: "Max lines to return. Default: 50", default: 50 },
        },
      },
    },
    {
      name: "search_code",
      description: "Full-text regex search across file contents. Like grep but returns structured results with context.",
      inputSchema: {
        type: "object" as const,
        properties: {
          pattern: { type: "string", description: "Regex pattern to search for" },
          file_pattern: { type: "string", description: "File glob to restrict search (e.g. '*.ts'). Default: all files" },
          max_results: { type: "number", description: "Max matches. Default: 20", default: 20 },
        },
        required: ["pattern"],
      },
    },
    {
      name: "delete_project",
      description: "Remove an indexed repository from the graph database.",
      inputSchema: {
        type: "object" as const,
        properties: {
          name: { type: "string", description: "Repository name to delete" },
        },
        required: ["name"],
      },
    },
    // ─── Memory Layer ────────────────────────────────────────────────────
    {
      name: "memory_load",
      description: "Load relevant project memory for a task. Returns past decisions, workflows, conventions, and gotchas. Token-budgeted: stops collecting when budget is hit. Uses FTS5 + staleness decay + type boosting for relevance.",
      inputSchema: {
        type: "object" as const,
        properties: {
          task: { type: "string", description: "Task description to find relevant memory for" },
          max_tokens: { type: "number", description: "Token budget for returned memory. Default: 2000", default: 2000 },
        },
        required: ["task"],
      },
    },
    {
      name: "memory_remember",
      description: "Save durable knowledge to project memory. Use for decisions, workflows, gotchas, and conventions that should persist across sessions. NOT for task transcripts or temporary state.",
      inputSchema: {
        type: "object" as const,
        properties: {
          type: { type: "string", enum: ["decision", "workflow", "gotcha", "convention", "context", "source", "synthesis"], description: "Type of knowledge being stored" },
          title: { type: "string", description: "Short descriptive title" },
          content: { type: "string", description: "The knowledge to remember" },
          tags: { type: "array", items: { type: "string" }, description: "Tags for retrieval" },
          symbols: { type: "array", items: { type: "string" }, description: "Related code symbols (function/class names)" },
          files: { type: "array", items: { type: "string" }, description: "Related file paths" },
          supersedes: { type: "string", description: "ID of an existing memory to replace (deletes old, creates new)" },
        },
        required: ["type", "title", "content"],
      },
    },
    {
      name: "memory_update",
      description: "Update an existing memory object's content, title, or tags in-place. Use when a decision or convention has changed but the memory ID should stay the same.",
      inputSchema: {
        type: "object" as const,
        properties: {
          id: { type: "string", description: "ID of the memory to update" },
          title: { type: "string", description: "New title (optional, keeps existing if omitted)" },
          content: { type: "string", description: "New content (optional, keeps existing if omitted)" },
          tags: { type: "array", items: { type: "string" }, description: "New tags (optional, keeps existing if omitted)" },
          symbols: { type: "array", items: { type: "string" }, description: "New symbols (optional)" },
          files: { type: "array", items: { type: "string" }, description: "New files (optional)" },
        },
        required: ["id"],
      },
    },
    {
      name: "memory_list",
      description: "List all stored project memory objects, optionally filtered by type.",
      inputSchema: {
        type: "object" as const,
        properties: {
          type: { type: "string", enum: ["decision", "workflow", "gotcha", "convention", "context", "source", "synthesis"], description: "Filter by memory type (optional)" },
        },
      },
    },
    {
      name: "memory_for_symbol",
      description: "Find all memory objects linked to a specific code symbol. Use when you need to understand decisions/conventions around a function or class.",
      inputSchema: {
        type: "object" as const,
        properties: {
          symbol: { type: "string", description: "Symbol name or FQN" },
        },
        required: ["symbol"],
      },
    },
    {
      name: "memory_for_file",
      description: "Find all memory objects linked to a specific file. Use when you need to understand conventions/decisions for a file before editing it.",
      inputSchema: {
        type: "object" as const,
        properties: {
          file: { type: "string", description: "File path" },
        },
        required: ["file"],
      },
    },
    {
      name: "memory_forget",
      description: "Delete a memory object by ID. Use when knowledge is outdated or wrong.",
      inputSchema: {
        type: "object" as const,
        properties: {
          id: { type: "string", description: "Memory object ID to delete" },
        },
        required: ["id"],
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

    // Semantic cache: check if we've seen a similar query recently
    const cacheableTools = ["fuzzy_find_symbol", "search_graph", "graph_walk", "find_by_path", "find_by_signature", "suggest_files"];
    const cacheKey = cacheableTools.includes(name) ? `${name}:${JSON.stringify(args)}` : null;

    if (cacheKey) {
      const cached = queryCache.get(cacheKey);
      if (cached) {
        const queryMs = performance.now() - startMs;
        const cachedResult = typeof cached.value === "object" && cached.value !== null ? cached.value : { data: cached.value };
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ ...(cachedResult as any), _meta: { query_ms: Math.round(queryMs * 100) / 100, tokens_returned: 0, cached: true, similarity: Math.round(cached.similarity * 100) / 100 } }, null, 2),
          }],
        };
      }
    }

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
      // ─── Context Tools ─────────────────────────────────────────────────
      case "get_file_context": {
        const filePath = args?.file_path as string;
        const maxTokens = Math.max(100, (args?.max_tokens as number) || 8000);
        const includeCallers = (args?.include_callers as boolean) || false;
        const dbInst = db.instance;

        // Find symbols in this file
        const fileSymbols = dbInst.prepare(
          "SELECT name, fqn, kind, start_line, end_line, byte_size FROM symbols WHERE file_path LIKE ? ORDER BY start_line"
        ).all(`%${filePath}%`) as any[];

        if (fileSymbols.length === 0) {
          result = { file: filePath, symbols: [], dependencies: [], message: "No symbols found in this file" };
          break;
        }

        // Get what these symbols call (outgoing edges)
        const dependencies: any[] = [];
        let tokensUsed = fileSymbols.reduce((sum: number, s: any) => sum + Math.ceil((s.byte_size || 200) / 4), 0);

        for (const sym of fileSymbols) {
          const outEdges = dbInst.prepare("SELECT target_fqn FROM edges WHERE source_fqn = ?").all(sym.fqn) as any[];
          for (const edge of outEdges) {
            if (tokensUsed >= maxTokens) break;
            const target = dbInst.prepare("SELECT name, fqn, kind, file_path, start_line, end_line FROM symbols WHERE fqn = ?").get(edge.target_fqn) as any;
            if (target && target.file_path !== filePath) {
              dependencies.push(target);
              tokensUsed += 50;
            }
          }
        }

        // Optionally get callers (incoming edges)
        let callers: any[] = [];
        if (includeCallers) {
          for (const sym of fileSymbols) {
            if (tokensUsed >= maxTokens) break;
            const inEdges = dbInst.prepare("SELECT source_fqn FROM edges WHERE target_fqn = ?").all(sym.fqn) as any[];
            for (const edge of inEdges) {
              if (tokensUsed >= maxTokens) break;
              const source = dbInst.prepare("SELECT name, fqn, kind, file_path FROM symbols WHERE fqn = ?").get(edge.source_fqn) as any;
              if (source && source.file_path !== filePath) {
                callers.push(source);
                tokensUsed += 50;
              }
            }
          }
        }

        result = {
          file: filePath,
          symbols: fileSymbols.map((s: any) => ({ name: s.name, kind: s.kind, line: s.start_line })),
          dependencies: [...new Map(dependencies.map((d: any) => [d.fqn, d])).values()],
          callers: includeCallers ? [...new Map(callers.map((c: any) => [c.fqn, c])).values()] : undefined,
          tokens_used: tokensUsed,
        };
        break;
      }
      case "explain_symbol": {
        const symbolName = args?.symbol as string;
        const dbInst = db.instance;

        // Resolve symbol
        const sym = dbInst.prepare(
          "SELECT name, fqn, kind, file_path, start_line, end_line, signature, byte_size FROM symbols WHERE name = ? OR fqn = ? OR fqn LIKE ? LIMIT 1"
        ).get(symbolName, symbolName, `%${symbolName}%`) as any;

        if (!sym) {
          result = { error: `Symbol not found: ${symbolName}` };
          break;
        }

        // Get callees (what it calls)
        const callees = dbInst.prepare(
          "SELECT target_fqn FROM edges WHERE source_fqn = ? ORDER BY target_fqn"
        ).all(sym.fqn) as any[];

        // Get callers (what calls it)
        const callerEdges = dbInst.prepare(
          "SELECT source_fqn FROM edges WHERE target_fqn = ? ORDER BY source_fqn"
        ).all(sym.fqn) as any[];

        // Resolve names
        const calleeNames = callees.map((e: any) => {
          const t = dbInst.prepare("SELECT name, file_path FROM symbols WHERE fqn = ?").get(e.target_fqn) as any;
          return t ? `${t.name} (${t.file_path})` : e.target_fqn.split(".").pop();
        });
        const callerNames = callerEdges.map((e: any) => {
          const s = dbInst.prepare("SELECT name, file_path FROM symbols WHERE fqn = ?").get(e.source_fqn) as any;
          return s ? `${s.name} (${s.file_path})` : e.source_fqn.split(".").pop();
        });

        result = {
          name: sym.name,
          fqn: sym.fqn,
          kind: sym.kind,
          file: sym.file_path,
          lines: `${sym.start_line}-${sym.end_line}`,
          signature: sym.signature || null,
          calls: calleeNames.slice(0, 20),
          called_by: callerNames.slice(0, 20),
          connectivity: callees.length + callerEdges.length,
        };
        break;
      }
      case "suggest_files": {
        const task = args?.task as string;
        const maxResults = Math.min(20, Math.max(1, (args?.max_results as number) || 10));
        const dbInst = db.instance;

        // Extract keywords from task
        const words = task.toLowerCase().split(/\s+/).filter(w => w.length > 2);

        // Score files by how many keyword-matching symbols they contain
        const fileScores = new Map<string, { score: number; matches: string[] }>();

        for (const word of words) {
          const matches = dbInst.prepare(
            "SELECT name, file_path FROM symbols WHERE LOWER(name) LIKE ?"
          ).all(`%${word}%`) as any[];

          for (const m of matches) {
            const existing = fileScores.get(m.file_path) || { score: 0, matches: [] };
            existing.score++;
            if (!existing.matches.includes(m.name)) existing.matches.push(m.name);
            fileScores.set(m.file_path, existing);
          }
        }

        // Also boost files that are highly connected
        for (const [filePath, data] of fileScores) {
          const edgeCount = dbInst.prepare(
            "SELECT COUNT(*) as c FROM edges WHERE source_fqn IN (SELECT fqn FROM symbols WHERE file_path = ?) OR target_fqn IN (SELECT fqn FROM symbols WHERE file_path = ?)"
          ).get(filePath, filePath) as any;
          data.score += Math.min(edgeCount.c / 10, 5); // bonus for connected files
        }

        const ranked = [...fileScores.entries()]
          .sort((a, b) => b[1].score - a[1].score)
          .slice(0, maxResults)
          .map(([path, data]) => ({ path, score: Math.round(data.score * 10) / 10, matching_symbols: data.matches.slice(0, 5) }));

        result = { task, suggestions: ranked };
        break;
      }
      case "find_dead_code": {
        const maxResults = Math.min(50, Math.max(1, (args?.max_results as number) || 20));
        const dbInst = db.instance;

        // Find symbols with zero inbound edges (nothing calls them)
        const dead = dbInst.prepare(`
          SELECT s.name, s.fqn, s.kind, s.file_path, s.start_line
          FROM symbols s
          WHERE s.kind IN ('function', 'class', 'method')
            AND NOT EXISTS (SELECT 1 FROM edges WHERE target_fqn = s.fqn)
            AND s.name NOT IN ('main', 'index', 'default', 'constructor')
          ORDER BY s.name
          LIMIT ?
        `).all(maxResults) as any[];

        result = { dead_symbols: dead, count: dead.length, note: "These symbols have zero inbound edges — nothing calls them." };
        break;
      }
      // ─── Code Access ───────────────────────────────────────────────────
      case "get_code_snippet": {
        const symbolName = args?.symbol as string | undefined;
        const filePath = args?.file_path as string | undefined;
        const maxLines = Math.min(200, Math.max(1, (args?.max_lines as number) || 50));
        const dbInst = db.instance;
        const fs = await import("fs");
        const path = await import("path");

        let targetFile: string | null = null;
        let startLine = (args?.start_line as number) || 0;
        let endLine = (args?.end_line as number) || 0;

        // Resolve symbol to file + lines
        if (symbolName) {
          const sym = dbInst.prepare(
            "SELECT file_path, start_line, end_line FROM symbols WHERE name = ? OR fqn = ? OR fqn LIKE ? LIMIT 1"
          ).get(symbolName, symbolName, `%${symbolName}%`) as any;
          if (sym) {
            targetFile = sym.file_path;
            if (!startLine) startLine = sym.start_line;
            if (!endLine) endLine = sym.end_line;
          }
        }

        if (!targetFile && filePath) targetFile = filePath;
        if (!targetFile) { result = { error: "Symbol or file not found" }; break; }

        // Find the repo root for this file
        const repos = dbInst.prepare("SELECT root_path FROM repositories").all() as any[];
        let fullPath: string | null = null;
        for (const repo of repos) {
          const candidate = path.join(repo.root_path, targetFile);
          if (fs.existsSync(candidate)) { fullPath = candidate; break; }
        }

        if (!fullPath) { result = { error: `File not found: ${targetFile}` }; break; }

        // Read the file
        const content = fs.readFileSync(fullPath, "utf-8");
        const allLines = content.split("\n");

        // Apply line range
        const from = Math.max(0, (startLine || 1) - 1);
        const to = Math.min(allLines.length, endLine || (from + maxLines));
        const snippet = allLines.slice(from, to);

        // Format with line numbers
        const numbered = snippet.map((line, i) => `${(from + i + 1).toString().padStart(4)} | ${line}`).join("\n");

        result = {
          file: targetFile,
          start_line: from + 1,
          end_line: to,
          total_lines: allLines.length,
          code: numbered,
          language: path.extname(targetFile).slice(1) || "text",
        };
        break;
      }
      case "search_code": {
        const pattern = args?.pattern as string;
        const filePattern = (args?.file_pattern as string) || "";
        const maxResults = Math.min(50, Math.max(1, (args?.max_results as number) || 20));
        const dbInst = db.instance;
        const fs = await import("fs");
        const path = await import("path");

        let regex: RegExp;
        try { regex = new RegExp(pattern, "gi"); }
        catch { result = { error: `Invalid regex: ${pattern}` }; break; }

        // Get all indexed files
        const files = dbInst.prepare("SELECT path, repo_id FROM indexed_files").all() as any[];
        const repos = dbInst.prepare("SELECT id, root_path FROM repositories").all() as any[];
        const repoMap = new Map(repos.map((r: any) => [r.id, r.root_path]));

        const matches: any[] = [];
        for (const file of files) {
          if (matches.length >= maxResults) break;
          if (filePattern && !file.path.match(filePattern.replace(/\*/g, ".*"))) continue;

          const rootPath = repoMap.get(file.repo_id);
          if (!rootPath) continue;
          const fullPath = path.join(rootPath, file.path);
          if (!fs.existsSync(fullPath)) continue;

          let content: string;
          try { content = fs.readFileSync(fullPath, "utf-8"); } catch { continue; }

          const lines = content.split("\n");
          for (let i = 0; i < lines.length && matches.length < maxResults; i++) {
            if (regex.test(lines[i])) {
              const contextStart = Math.max(0, i - 1);
              const contextEnd = Math.min(lines.length, i + 2);
              matches.push({
                file: file.path,
                line: i + 1,
                match: lines[i].trim().slice(0, 200),
                context: lines.slice(contextStart, contextEnd).join("\n"),
              });
            }
            regex.lastIndex = 0; // reset for global regex
          }
        }

        result = { pattern, matches, total: matches.length };
        break;
      }
      case "delete_project": {
        const repoName = args?.name as string;
        const dbInst = db.instance;

        const repo = dbInst.prepare("SELECT id FROM repositories WHERE name = ?").get(repoName) as any;
        if (!repo) { result = { error: `Repository not found: ${repoName}` }; break; }

        dbInst.prepare("DELETE FROM symbols WHERE repo_id = ?").run(repo.id);
        dbInst.prepare("DELETE FROM edges WHERE repo_id = ?").run(repo.id);
        dbInst.prepare("DELETE FROM indexed_files WHERE repo_id = ?").run(repo.id);
        dbInst.prepare("DELETE FROM repositories WHERE id = ?").run(repo.id);

        result = { deleted: repoName, message: "Repository and all its data removed from the graph." };
        break;
      }
      // ─── Memory Layer ──────────────────────────────────────────────────
      case "memory_load": {
        const task = args?.task as string;
        const maxTokens = Math.max(100, (args?.max_tokens as number) || 2000);
        const { objects, tokens_used, score_breakdown } = memory.loadForTask(task, maxTokens);
        if (objects.length === 0) {
          result = { objects: [], tokens_used: 0, message: "No relevant memory found.", stats: memory.stats() };
        } else {
          result = {
            objects: objects.map(o => ({ id: o.id, type: o.type, title: o.title, content: o.content, tags: o.tags, symbols: o.symbols, files: o.files })),
            context: memory.formatForContext(objects, maxTokens),
            count: objects.length,
            tokens_used,
            scoring: score_breakdown,
          };
        }
        break;
      }
      case "memory_remember": {
        const obj = memory.remember({
          type: (args?.type as any) || "context",
          title: args?.title as string,
          content: args?.content as string,
          tags: (args?.tags as string[]) || [],
          symbols: (args?.symbols as string[]) || [],
          files: (args?.files as string[]) || [],
          supersedes: (args?.supersedes as string) || undefined,
        });
        if ("duplicate" in obj) {
          result = { deduplicated: true, existing_id: obj.existing_id, message: "Near-identical memory already exists. Confirmed it as still valid." };
        } else {
          result = { remembered: { id: obj.id, type: obj.type, title: obj.title }, message: `Saved: [${obj.type}] ${obj.title}` };
        }
        break;
      }
      case "memory_list": {
        const filterType = args?.type as string | undefined;
        const objects = filterType ? memory.byType(filterType as any) : memory.all();
        result = {
          objects: objects.map(o => ({ id: o.id, type: o.type, title: o.title, tags: o.tags, createdAt: o.created_at })),
          count: objects.length,
          stats: memory.stats(),
        };
        break;
      }
      case "memory_for_symbol": {
        const symbol = args?.symbol as string;
        const objects = memory.forSymbol(symbol);
        result = {
          symbol,
          objects: objects.map(o => ({ id: o.id, type: o.type, title: o.title, content: o.content })),
          count: objects.length,
        };
        break;
      }
      case "memory_for_file": {
        const file = args?.file as string;
        const objects = memory.forFile(file);
        result = {
          file,
          objects: objects.map(o => ({ id: o.id, type: o.type, title: o.title, content: o.content })),
          count: objects.length,
        };
        break;
      }
      case "memory_forget": {
        const id = args?.id as string;
        const success = memory.forget(id);
        result = success ? { deleted: id, message: "Memory object deleted." } : { error: `Memory ${id} not found.` };
        break;
      }
      case "memory_update": {
        const id = args?.id as string;
        if (!id) {
          return { content: [{ type: "text", text: JSON.stringify({ error: "Missing required parameter: id" }) }], isError: true };
        }
        const updated = memory.update(id, {
          title: args?.title as string | undefined,
          content: args?.content as string | undefined,
          tags: args?.tags as string[] | undefined,
          symbols: args?.symbols as string[] | undefined,
          files: args?.files as string[] | undefined,
        });
        if (updated) {
          result = { updated: { id: updated.id, type: updated.type, title: updated.title }, message: `Updated: [${updated.type}] ${updated.title}` };
        } else {
          result = { error: `Memory ${id} not found.` };
        }
        break;
      }
      default:
        return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
    }

    const queryMs = performance.now() - startMs;

    // Cache the result for similar future queries
    if (cacheKey && result) {
      queryCache.set(cacheKey, result);
    }

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
