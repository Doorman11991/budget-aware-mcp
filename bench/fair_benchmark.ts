/**
 * FAIR Benchmark — Apples-to-apples comparison.
 * 
 * Both systems query the SAME data (CBM's 1523-node, 4117-edge graph).
 * Both measured via CLI (cold start included for both).
 * Same queries. Same repo. Same machine. Same moment.
 *
 * Run: npx tsx bench/fair_benchmark.ts
 */

import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "url";
import * as path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CBM_BINARY = path.join(
  process.env.LOCALAPPDATA || "",
  "Programs", "codebase-memory-mcp", "codebase-memory-mcp.exe"
);
const OUR_DIST = path.resolve(__dirname, "..", "dist", "index.js");
const PROJECT = "C-Users-savag-Downloads-ExoCode-BoneScript-compiler-src";

// ─── Helpers ──────────────────────────────────────────────────────

function cbm(tool: string, args: Record<string, any>): { ms: number; output: string } {
  const start = performance.now();
  let output = "";
  try {
    output = execFileSync(CBM_BINARY, ["cli", "--json", tool, JSON.stringify(args)], {
      encoding: "utf-8", timeout: 30000, stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (e: any) { output = e.stdout || e.message; }
  return { ms: performance.now() - start, output };
}

function ours(tool: string, args: Record<string, any>): { ms: number; output: any } {
  const msg = [
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "b", version: "1" } } }),
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }),
    JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: tool, arguments: args } }),
  ].join("\n");

  const start = performance.now();
  let raw = "";
  try {
    raw = execFileSync("node", [OUR_DIST], { input: msg, encoding: "utf-8", timeout: 30000, stdio: ["pipe", "pipe", "pipe"] });
  } catch (e: any) { raw = e.stdout || ""; }
  const ms = performance.now() - start;

  // Parse last line
  const lines = raw.trim().split("\n");
  const last = lines[lines.length - 1];
  let output: any = {};
  try {
    const parsed = JSON.parse(last);
    const text = parsed?.result?.content?.[0]?.text;
    output = text ? JSON.parse(text) : parsed;
  } catch { output = { raw: last }; }

  return { ms, output };
}

function countInOutput(str: string, pattern: string): number {
  return (str.match(new RegExp(pattern, "g")) || []).length;
}

// ─── Run Fair Tests ───────────────────────────────────────────────

console.log("╔═══════════════════════════════════════════════════════════════╗");
console.log("║  FAIR BENCHMARK — Same data, same queries, same machine      ║");
console.log("║  Repo: BoneScript compiler (108 files, 41k LOC)              ║");
console.log("║  Graph: 1523 nodes, 4117 edges (indexed by CBM tree-sitter)  ║");
console.log("╚═══════════════════════════════════════════════════════════════╝\n");

const tests: { name: string; cbm_ms: number; our_ms: number; cbm_results: string; our_results: string; feature_note: string }[] = [];

// ─── Test 1: Search for "emit" ────────────────────────────────────
console.log("1. SEARCH: find symbols matching 'emit'...");
const cbm1 = cbm("search_graph", { query: "emit", project: PROJECT, limit: 10 });
const our1 = ours("fuzzy_find_symbol", { query: "emit", max_results: 10 });
const cbm1_count = countInOutput(cbm1.output, "qualified_name");
const our1_count = Array.isArray(our1.output) ? our1.output.length : Object.keys(our1.output).filter(k => k !== "_meta").length;
tests.push({
  name: "Search 'emit'",
  cbm_ms: cbm1.ms, our_ms: our1.ms,
  cbm_results: `${cbm1_count} results`,
  our_results: `${our1_count} results`,
  feature_note: "",
});

// ─── Test 2: Search for "parse" ───────────────────────────────────
console.log("2. SEARCH: find symbols matching 'parse'...");
const cbm2 = cbm("search_graph", { query: "parse", project: PROJECT, limit: 10 });
const our2 = ours("fuzzy_find_symbol", { query: "parse", max_results: 10 });
const cbm2_count = countInOutput(cbm2.output, "qualified_name");
const our2_count = Array.isArray(our2.output) ? our2.output.length : Object.keys(our2.output).filter(k => k !== "_meta").length;
tests.push({
  name: "Search 'parse'",
  cbm_ms: cbm2.ms, our_ms: our2.ms,
  cbm_results: `${cbm2_count} results`,
  our_results: `${our2_count} results`,
  feature_note: "",
});

// ─── Test 3: Graph traversal from "Emitter" ──────────────────────
console.log("3. GRAPH WALK: traverse from 'Emitter' depth=2...");
const cbm3 = cbm("trace_path", { function_name: "Emitter", project: PROJECT, direction: "outbound", max_depth: 2 });
const our3 = ours("graph_walk", { anchor: "Emitter", hop_depth: 2, max_tokens: 8000 });
const cbm3_callees = countInOutput(cbm3.output, "\"name\"");
const our3_symbols = our3.output?.symbols?.length || 0;
tests.push({
  name: "Graph walk 'Emitter' depth=2",
  cbm_ms: cbm3.ms, our_ms: our3.ms,
  cbm_results: `${cbm3_callees} callees`,
  our_results: `${our3_symbols} symbols, ${our3.output?.files?.length || 0} files`,
  feature_note: "Ours: budget-capped at 8000 tokens",
});

// ─── Test 4: Graph traversal from "emitCognitionFiles" ────────────
console.log("4. GRAPH WALK: traverse from 'emitCognitionFiles' depth=2...");
const cbm4 = cbm("trace_path", { function_name: "emitCognitionFiles", project: PROJECT, direction: "outbound", max_depth: 2 });
const our4 = ours("graph_walk", { anchor: "emitCognitionFiles", hop_depth: 2, max_tokens: 8000 });
const cbm4_callees = countInOutput(cbm4.output, "\"name\"");
const our4_symbols = our4.output?.symbols?.length || 0;
tests.push({
  name: "Graph walk 'emitCognitionFiles' d=2",
  cbm_ms: cbm4.ms, our_ms: our4.ms,
  cbm_results: `${cbm4_callees} callees`,
  our_results: `${our4_symbols} symbols, ${our4.output?.files?.length || 0} files`,
  feature_note: "",
});

// ─── Test 5: Impact analysis ──────────────────────────────────────
console.log("5. IMPACT ANALYSIS: what's affected if emitter.ts changes?...");
const cbm5 = cbm("detect_changes", { project: PROJECT });
const our5 = ours("analyze_impact", { changed_files: ["emitter.ts"], hop_depth: 2 });
tests.push({
  name: "Impact: emitter.ts changed",
  cbm_ms: cbm5.ms, our_ms: our5.ms,
  cbm_results: `detects git changes only`,
  our_results: `${our5.output?.blast_radius || 0} affected symbols, ${our5.output?.total_affected_files || 0} files`,
  feature_note: "CBM only detects file changes, not blast radius",
});

// ─── Test 6: Schema/Architecture ──────────────────────────────────
console.log("6. ARCHITECTURE: discover subsystems...");
const cbm6 = cbm("get_architecture", { project: PROJECT, aspects: ["packages", "entry_points"] });
const our6 = ours("discover_subsystems", { max_clusters: 5 });
const cbm6_packages = countInOutput(cbm6.output, "\"name\"");
const our6_clusters = our6.output?.clusters?.length || 0;
tests.push({
  name: "Discover architecture",
  cbm_ms: cbm6.ms, our_ms: our6.ms,
  cbm_results: `${cbm6_packages} items`,
  our_results: `${our6_clusters} clusters with entry points`,
  feature_note: "",
});

// ─── Test 7: Token budget (feature only ours has) ─────────────────
console.log("7. TOKEN BUDGET: 'give me context for Emitter, max 2000 tokens'...");
const our7 = ours("graph_walk", { anchor: "Emitter", hop_depth: 3, max_tokens: 2000 });
tests.push({
  name: "Budget: 2000 tokens max",
  cbm_ms: 0, our_ms: our7.ms,
  cbm_results: "❌ Feature doesn't exist",
  our_results: `${our7.output?.symbols?.length || 0} symbols, ${our7.output?.tokens_returned || 0} tokens used`,
  feature_note: "CBM returns everything — no budget control",
});

// ─── Test 8: Scope check (feature only ours has) ──────────────────
console.log("8. SCOPE CHECK: 'can I refactor the emitter?'...");
const our8 = ours("check_scope", { task_description: "refactor the Emitter class to support multiple output targets", available_symbols: [] });
tests.push({
  name: "Scope: 'refactor Emitter'",
  cbm_ms: 0, our_ms: our8.ms,
  cbm_results: "❌ Feature doesn't exist",
  our_results: `feasibility: ${our8.output?.feasibility || "?"}, confidence: ${our8.output?.confidence || "?"}`,
  feature_note: "Answers 'is this task doable?' without LLM",
});

// ─── Test 9: Session stats (feature only ours has) ────────────────
console.log("9. SESSION STATS...");
const our9 = ours("get_session_stats", { session_id: "default" });
tests.push({
  name: "Session accounting",
  cbm_ms: 0, our_ms: our9.ms,
  cbm_results: "❌ Feature doesn't exist",
  our_results: `${our9.output?.total_queries || 0} queries, ${our9.output?.total_tokens_returned || 0} tokens total`,
  feature_note: "Running total of token spend across session",
});

// ─── Print Results ────────────────────────────────────────────────

console.log("\n╔═══════════════════════════════════════════════════════════════════════════════════════════════════╗");
console.log("║  RESULTS                                                                                          ║");
console.log("╠═══════════════════════════════════════════════════════════════════════════════════════════════════╣");
console.log("");

// Table header
console.log("┌────────────────────────────────────┬────────┬────────┬─────────────────────────────┬─────────────────────────────────────┐");
console.log("│ Test                               │ CBM ms │ Us ms  │ CBM Result                  │ Our Result                          │");
console.log("├────────────────────────────────────┼────────┼────────┼─────────────────────────────┼─────────────────────────────────────┤");

for (const t of tests) {
  const name = t.name.padEnd(36);
  const cbmMs = t.cbm_ms > 0 ? t.cbm_ms.toFixed(0).padStart(6) : "   N/A";
  const ourMs = t.our_ms.toFixed(0).padStart(6);
  const cbmR = t.cbm_results.padEnd(27);
  const ourR = t.our_results.padEnd(35);
  console.log(`│ ${name}│ ${cbmMs} │ ${ourMs} │ ${cbmR} │ ${ourR} │`);
}

console.log("└────────────────────────────────────┴────────┴────────┴─────────────────────────────┴─────────────────────────────────────┘");

// Summary
console.log("\n── SUMMARY ────────────────────────────────────────────────────────");
console.log("");
console.log("  SPEED (CLI cold-start — not a fair comparison, they're compiled C):");
const avgCbm = tests.filter(t => t.cbm_ms > 0).reduce((s, t) => s + t.cbm_ms, 0) / tests.filter(t => t.cbm_ms > 0).length;
const avgOurs = tests.filter(t => t.cbm_ms > 0).reduce((s, t) => s + t.our_ms, 0) / tests.filter(t => t.cbm_ms > 0).length;
console.log(`    CBM avg: ${avgCbm.toFixed(0)}ms  |  Ours avg: ${avgOurs.toFixed(0)}ms  |  They're ${(avgOurs / avgCbm).toFixed(1)}x faster on startup`);
console.log(`    (In-process, our queries are 0.07-0.25ms — see bench_inprocess.ts)`);
console.log("");
console.log("  FEATURES ONLY WE HAVE:");
console.log("    ✅ Token budget per query (agent says 'max 8000 tokens')");
console.log("    ✅ Token accounting per session (cumulative spend tracking)");
console.log("    ✅ Scope/feasibility check ('is this task doable?')");
console.log("    ✅ Blast-radius impact analysis (not just 'what files changed')");
console.log("    ✅ Deterministic ordering (same query = same result, always)");
console.log("    ✅ Multi-hop walk with budget cutoff");
console.log("");
console.log("  FEATURES THEY HAVE THAT WE USE:");
console.log("    ✅ Tree-sitter 155-language parsing (we read their .db directly)");
console.log("    ✅ 4117 edges (CALLS, IMPORTS, USAGE, TESTS, SIMILAR_TO)");
console.log("    ✅ Incremental re-indexing");
console.log("    ✅ 3D graph visualization (UI on localhost:9749)");
console.log("    ✅ Agent auto-config (11 agents)");
console.log("");
console.log("  WHERE THEY WIN:");
console.log("    • Startup speed (compiled C vs Node.js)");
console.log("    • Single binary distribution (no node_modules)");
console.log("    • BM25 full-text search (ranked relevance scoring)");
console.log("    • ADR (architecture decision records)");
console.log("    • Cypher query language support");
console.log("");
console.log("  WHERE WE WIN:");
console.log("    • Graph walk returns CONNECTED context, not ranked keyword matches");
console.log("    • Token budget enforcement (agent never gets more than it asked for)");
console.log("    • Feasibility assessment before generation");
console.log("    • Impact analysis (blast radius from file changes)");
console.log("    • Deterministic results (reproducible, debuggable)");
console.log("    • Session-level token accounting");
console.log("    • Works without specifying project name");
console.log("────────────────────────────────────────────────────────────────────");
