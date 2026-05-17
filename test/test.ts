/**
 * budget-aware-mcp test suite
 *
 * Run: npx tsx test/test.ts
 *
 * Tests: DB init, indexing, graph walk, fuzzy search, scope check,
 * semantic cache, edge resolution, explain symbol, code snippet.
 */

import { strict as assert } from "node:assert";
import * as path from "path";
import * as fs from "fs";
import { fileURLToPath } from "url";
import { pathToFileURL } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const toUrl = (p: string) => pathToFileURL(path.resolve(p)).href;

const { db } = await import(toUrl(path.resolve(__dirname, "..", "dist", "db.js")));
const { GraphWalker } = await import(toUrl(path.resolve(__dirname, "..", "dist", "retrieval", "graph_walk.js")));
const { FuzzyFinder } = await import(toUrl(path.resolve(__dirname, "..", "dist", "retrieval", "fuzzy.js")));
const { ScopeChecker } = await import(toUrl(path.resolve(__dirname, "..", "dist", "retrieval", "scope_check.js")));
const { SemanticCache } = await import(toUrl(path.resolve(__dirname, "..", "dist", "retrieval", "semantic_cache.js")));
const { Indexer } = await import(toUrl(path.resolve(__dirname, "..", "dist", "index", "indexer.js")));

// Use a temp DB for tests
process.env.CODE_GRAPH_DB = path.join(__dirname, ".test.db");

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void | Promise<void>) {
  try {
    const result = fn();
    if (result instanceof Promise) {
      return result.then(() => { passed++; console.log(`  ✓ ${name}`); })
        .catch((e: any) => { failed++; console.log(`  ✗ ${name}: ${e.message}`); });
    }
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e: any) {
    failed++;
    console.log(`  ✗ ${name}: ${e.message}`);
  }
}

// ─── Setup ────────────────────────────────────────────────────────

console.log("\nbudget-aware-mcp test suite\n");

// Clean test DB
const testDb = path.join(__dirname, ".test.db");
if (fs.existsSync(testDb)) fs.unlinkSync(testDb);

db.initialize();

// ─── DB Tests ─────────────────────────────────────────────────────

console.log("── Database ──");

await test("DB initializes without error", () => {
  const tables = db.instance.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
  assert(tables.length >= 4, `Expected 4+ tables, got ${tables.length}`);
});

await test("Tables exist: repositories, symbols, edges, indexed_files, sessions", () => {
  const names = db.instance.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((t: any) => t.name);
  assert(names.includes("repositories"));
  assert(names.includes("symbols"));
  assert(names.includes("edges"));
  assert(names.includes("indexed_files"));
  assert(names.includes("sessions"));
});

// ─── Indexer Tests ────────────────────────────────────────────────

console.log("\n── Indexer ──");

const testProjectDir = path.resolve(__dirname, "..", "src");
const indexer = new Indexer(db);

await test("Index own source code", async () => {
  const result = await indexer.indexRepo(testProjectDir, "test-project");
  assert(result.file_count > 5, `Expected 5+ files, got ${result.file_count}`);
  assert(result.symbol_count > 10, `Expected 10+ symbols, got ${result.symbol_count}`);
  assert(result.index_duration_ms < 5000, `Took too long: ${result.index_duration_ms}ms`);
});

await test("Symbols extracted correctly", async () => {
  const syms = db.instance.prepare("SELECT COUNT(*) as c FROM symbols WHERE repo_id = (SELECT id FROM repositories WHERE name='test-project')").get() as any;
  assert(syms.c > 10, `Expected 10+ symbols, got ${syms.c}`);
});

await test("Edges resolved (call resolution)", async () => {
  const edges = db.instance.prepare("SELECT COUNT(*) as c FROM edges WHERE repo_id = (SELECT id FROM repositories WHERE name='test-project')").get() as any;
  assert(edges.c > 5, `Expected 5+ edges, got ${edges.c}`);
});

await test("Re-index doesn't crash", async () => {
  const result = await indexer.indexRepo(testProjectDir, "test-project");
  assert(result.file_count > 0);
});

// ─── Graph Walk Tests ─────────────────────────────────────────────

console.log("\n── Graph Walk ──");

const walker = new GraphWalker(db);

await test("Walk from known symbol returns results", async () => {
  const result = await walker.walk("GraphWalker", 1, 4000);
  assert(result.symbols.length >= 1, `Expected 1+ symbols, got ${result.symbols.length}`);
});

await test("Walk respects token budget", async () => {
  const small = await walker.walk("GraphWalker", 3, 3000);
  const large = await walker.walk("GraphWalker", 3, 50000);
  assert(small.tokens_returned <= large.tokens_returned, "Smaller budget should return fewer tokens");
  assert(small.symbols.length <= large.symbols.length, "Smaller budget should return fewer symbols");
});

await test("Walk returns deterministic results", async () => {
  const r1 = await walker.walk("GraphWalker", 2, 4000);
  const r2 = await walker.walk("GraphWalker", 2, 4000);
  assert.deepEqual(r1.symbols.map((s: any) => s.fqn), r2.symbols.map((s: any) => s.fqn));
});

await test("Walk with unknown symbol returns empty", async () => {
  const result = await walker.walk("NonExistentSymbol12345", 2, 4000);
  assert(result.symbols.length === 0);
});

// ─── Fuzzy Search Tests ───────────────────────────────────────────

console.log("\n── Fuzzy Search ──");

const fuzzy = new FuzzyFinder(db);

await test("Fuzzy find by exact name", async () => {
  const results = await fuzzy.findSymbol("GraphWalker", 5);
  assert(results.length >= 1);
  assert(results[0].name === "GraphWalker" || results[0].fqn?.includes("GraphWalker"));
});

await test("Fuzzy find by partial name", async () => {
  const results = await fuzzy.findSymbol("Walk", 5);
  assert(results.length >= 1);
});

await test("Fuzzy find respects max_results", async () => {
  const results = await fuzzy.findSymbol("a", 3);
  assert(results.length <= 3);
});

// ─── Scope Check Tests ────────────────────────────────────────────

console.log("\n── Scope Check ──");

const scope = new ScopeChecker(db);

await test("Scope check finds existing symbols", async () => {
  const result = await scope.check("refactor the GraphWalker class", []);
  assert(result.found_symbols.length >= 1);
  assert(result.feasibility === "full" || result.feasibility === "partial");
});

await test("Scope check reports unknown symbols", async () => {
  const result = await scope.check("implement the FooBarBaz module", []);
  assert(result.feasibility === "unknown" || result.missing_symbols.length > 0);
});

// ─── Semantic Cache Tests ─────────────────────────────────────────

console.log("\n── Semantic Cache ──");

await test("Cache stores and retrieves exact match", () => {
  const cache = new SemanticCache();
  cache.set("hello world", { data: 42 });
  const hit = cache.get("hello world");
  assert(hit !== null);
  assert((hit.value as any).data === 42);
  assert(hit.similarity === 1.0);
});

await test("Cache hits on similar queries", () => {
  const cache = new SemanticCache(0.6);
  cache.set("authentication handler", { data: "auth" });
  const hit = cache.get("authenticate handler");
  assert(hit !== null, "Expected cache hit for similar query");
  assert(hit.similarity >= 0.6);
});

await test("Cache misses on dissimilar queries", () => {
  const cache = new SemanticCache(0.7);
  cache.set("payment processing", { data: "pay" });
  const hit = cache.get("user interface design");
  assert(hit === null, "Expected cache miss for dissimilar query");
});

await test("Cache respects TTL", () => {
  const cache = new SemanticCache(0.7, 100, 1); // 1ms TTL
  cache.set("test query", { data: "old" });
  // Wait for expiry
  const start = Date.now();
  while (Date.now() - start < 5) {} // busy wait 5ms
  const hit = cache.get("test query");
  assert(hit === null, "Expected cache miss after TTL expiry");
});

// ─── Cleanup ──────────────────────────────────────────────────────

db.close();
if (fs.existsSync(testDb)) fs.unlinkSync(testDb);

// ─── Summary ──────────────────────────────────────────────────────

console.log(`\n${"═".repeat(40)}`);
console.log(`  ${passed} passed, ${failed} failed`);
console.log(`${"═".repeat(40)}\n`);

if (failed > 0) process.exit(1);
