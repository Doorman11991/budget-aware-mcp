// Indexer — integrates with DeusData codebase-memory-mcp C binary.
//
// Architecture (from PLAN.md):
//   INDEX LAYER (from DeusData — battle-tested):
//     • tree-sitter 155-language parsing
//     • SQLite persistence (in-memory + on-disk)
//     • LZ4 compression
//     • infra indexing (Docker/k8s/Kustomize)
//     • cross-repo shared graph
//     • incremental re-indexing
//
//   RETRIEVAL LAYER (our code — the differentiator):
//     • hop-based graph walk
//     • fuzzy discovery
//     • scope/feasibility check
//     • token-budget-aware truncation
//
// The C binary produces a SQLite DB with schema:
//   nodes(id, project, label, name, qualified_name, file_path, start_line, end_line, properties)
//   edges(id, project, source_id, target_id, type, properties)
//   file_hashes(project, rel_path, sha256, mtime_ns, size)
//   projects(name, indexed_at, root_path)
//
// We call it via CLI mode: `codebase-memory-mcp cli <tool> <json>`
// Then read the resulting .db with better-sqlite3.

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "node:crypto";
import { execFileSync } from "node:child_process";

// Default binary locations
const CBM_BINARY_PATHS = [
  // Installed via install.ps1
  path.join(process.env.LOCALAPPDATA || "", "Programs", "codebase-memory-mcp", "codebase-memory-mcp.exe"),
  // Installed via install.sh (Unix)
  path.join(os.homedir(), ".local", "bin", "codebase-memory-mcp"),
  // PATH fallback
  "codebase-memory-mcp",
];

// DeusData store location
function getCbmCacheDir(): string {
  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "codebase-memory-mcp");
  }
  return path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "codebase-memory-mcp");
}

export class Indexer {
  private binaryPath: string | null = null;
  private db: any;

  constructor(db: any) {
    this.db = db;
    this.binaryPath = this.findBinary();
  }

  /**
   * Locate the codebase-memory-mcp binary.
   */
  private findBinary(): string | null {
    for (const candidate of CBM_BINARY_PATHS) {
      try {
        if (candidate === "codebase-memory-mcp") {
          // Try as PATH command
          execFileSync(candidate, ["--version"], { stdio: "pipe", timeout: 5000 });
          return candidate;
        } else if (fs.existsSync(candidate)) {
          return candidate;
        }
      } catch {
        continue;
      }
    }
    return null;
  }

  /**
   * Index a repository using the DeusData C binary (155-language tree-sitter).
   * Falls back to our built-in regex parser if the binary isn't installed.
   */
  async indexRepo(repoPath: string, repoName?: string): Promise<any> {
    const absPath = path.resolve(repoPath);
    if (!fs.existsSync(absPath)) {
      throw new Error(`Repository path does not exist: ${absPath}`);
    }

    const name = repoName || path.basename(absPath);

    if (this.binaryPath) {
      return this.indexViaCbmBinary(absPath, name);
    } else {
      return this.indexViaBuiltinParser(absPath, name);
    }
  }

  /**
   * Index using the DeusData C binary — tree-sitter, 155 languages,
   * incremental re-indexing, cross-repo intelligence.
   */
  private indexViaCbmBinary(absPath: string, name: string): any {
    const startTime = Date.now();

    // Call the binary's index_repository tool
    const args = JSON.stringify({ repo_path: absPath });
    let result: string;
    try {
      result = execFileSync(this.binaryPath!, ["cli", "index_repository", args], {
        encoding: "utf-8",
        timeout: 300000, // 5 min timeout
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (e: any) {
      // If binary fails, fall back to built-in
      console.error(`[code-graph-mcp] C binary index failed, falling back to built-in: ${e.message}`);
      return this.indexViaBuiltinParser(absPath, name);
    }

    // Now import the data from the CBM store into our own SQLite
    const cbmDbPath = this.findCbmDb(absPath);
    if (cbmDbPath && fs.existsSync(cbmDbPath)) {
      return this.importFromCbmStore(cbmDbPath, absPath, name, startTime);
    }

    // Fallback if we can't find the .db
    return this.indexViaBuiltinParser(absPath, name);
  }

  /**
   * Find the CBM .db file for a given repo path.
   * DeusData stores at: ~/.cache/codebase-memory-mcp/<project-name>.db
   * Project name is derived from the path (replace /, :, spaces with -).
   */
  private findCbmDb(repoPath: string): string | null {
    const cacheDir = getCbmCacheDir();
    if (!fs.existsSync(cacheDir)) return null;

    // DeusData project naming: replace / and : with -, collapse --, trim leading -
    const projectName = repoPath
      .replace(/[/\\:]/g, "-")
      .replace(/--+/g, "-")
      .replace(/^-/, "")
      .toLowerCase();

    // Try exact match first
    const exactPath = path.join(cacheDir, `${projectName}.db`);
    if (fs.existsSync(exactPath)) return exactPath;

    // Try to find by scanning the directory for a matching root_path
    try {
      const files = fs.readdirSync(cacheDir).filter(f => f.endsWith(".db"));
      for (const file of files) {
        const dbPath = path.join(cacheDir, file);
        try {
          const Database = require("better-sqlite3");
          const testDb = new Database(dbPath, { readonly: true });
          const project = testDb.prepare("SELECT root_path FROM projects LIMIT 1").get() as any;
          testDb.close();
          if (project && path.resolve(project.root_path) === path.resolve(repoPath)) {
            return dbPath;
          }
        } catch { continue; }
      }
    } catch { /* directory read failed */ }

    return null;
  }

  /**
   * Import nodes and edges from a CBM SQLite store into our own DB.
   * Maps their schema to ours:
   *   CBM nodes → our symbols table
   *   CBM edges → our edges table
   */
  private importFromCbmStore(cbmDbPath: string, repoPath: string, repoName: string, startTime: number): any {
    const dbInst = this.db.instance;
    const Database = require("better-sqlite3");
    const cbmDb = new Database(cbmDbPath, { readonly: true });

    // Upsert repository
    let repo = dbInst.prepare("SELECT id FROM repositories WHERE root_path = ?").get(repoPath) as any;
    if (repo) {
      dbInst.prepare("DELETE FROM symbols WHERE repo_id = ?").run(repo.id);
      dbInst.prepare("DELETE FROM edges WHERE repo_id = ?").run(repo.id);
      dbInst.prepare("DELETE FROM indexed_files WHERE repo_id = ?").run(repo.id);
    } else {
      dbInst.prepare(
        "INSERT INTO repositories (name, root_path, file_count, symbol_count, edge_count, total_loc, languages, last_indexed_at, index_duration_ms, state) VALUES (?, ?, 0, 0, 0, 0, '[]', datetime('now'), 0, 'indexing')"
      ).run(repoName, repoPath);
      repo = dbInst.prepare("SELECT id FROM repositories WHERE root_path = ?").get(repoPath) as any;
    }
    const repoId = repo.id;

    // Get CBM project name
    const cbmProject = cbmDb.prepare("SELECT name FROM projects LIMIT 1").get() as any;
    const projectFilter = cbmProject?.name || "";

    // Import nodes as symbols
    const cbmNodes = cbmDb.prepare(
      "SELECT id, label, name, qualified_name, file_path, start_line, end_line, properties FROM nodes WHERE project = ?"
    ).all(projectFilter) as any[];

    const insertSymbol = dbInst.prepare(`
      INSERT INTO symbols (name, fqn, kind, file_path, start_line, end_line, language, signature, docstring, content_hash, byte_size, content_lz4, repo_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', '', 0, '', ?)
    `);

    // Map CBM node IDs to our FQNs for edge resolution
    const nodeIdToFqn = new Map<number, string>();
    const languages = new Set<string>();
    let totalSymbols = 0;

    const importNodes = dbInst.transaction(() => {
      for (const node of cbmNodes) {
        const kind = (node.label || "unknown").toLowerCase();
        const fqn = node.qualified_name || `${repoName}.${node.name}`;
        const filePath = node.file_path || "";

        // Extract language from file extension
        const ext = path.extname(filePath).slice(1);
        if (ext) languages.add(ext);

        // Extract signature from properties JSON
        let signature = "";
        try {
          const props = JSON.parse(node.properties || "{}");
          signature = props.signature || props.type_hint || "";
        } catch { /* ignore parse errors */ }

        insertSymbol.run(
          node.name, fqn, kind, filePath,
          node.start_line || 0, node.end_line || 0,
          ext, signature, repoId
        );

        nodeIdToFqn.set(node.id, fqn);
        totalSymbols++;
      }
    });
    importNodes();

    // Import edges
    const cbmEdges = cbmDb.prepare(
      "SELECT source_id, target_id, type FROM edges WHERE project = ?"
    ).all(projectFilter) as any[];

    const insertEdge = dbInst.prepare(`
      INSERT INTO edges (source_fqn, target_fqn, kind, weight, file_path, repo_id)
      VALUES (?, ?, ?, ?, '', ?)
    `);

    let totalEdges = 0;
    const importEdges = dbInst.transaction(() => {
      for (const edge of cbmEdges) {
        const sourceFqn = nodeIdToFqn.get(edge.source_id);
        const targetFqn = nodeIdToFqn.get(edge.target_id);
        if (!sourceFqn || !targetFqn) continue;

        // Map CBM edge types to our types
        const kind = this.mapEdgeType(edge.type);
        insertEdge.run(sourceFqn, targetFqn, kind, 1.0, repoId);
        totalEdges++;
      }
    });
    importEdges();

    // Import file list
    const cbmFiles = cbmDb.prepare(
      "SELECT rel_path, sha256, size FROM file_hashes WHERE project = ?"
    ).all(projectFilter) as any[];

    const insertFile = dbInst.prepare(`
      INSERT INTO indexed_files (path, language, byte_size, line_count, content_hash, last_indexed_at, symbol_count, repo_id, state)
      VALUES (?, ?, ?, 0, ?, datetime('now'), 0, ?, 'indexed')
    `);

    const importFiles = dbInst.transaction(() => {
      for (const file of cbmFiles) {
        const ext = path.extname(file.rel_path).slice(1);
        insertFile.run(file.rel_path, ext, file.size || 0, file.sha256 || "", repoId);
      }
    });
    importFiles();

    cbmDb.close();

    // Update repository stats
    const durationMs = Date.now() - startTime;
    const totalLoc = cbmFiles.reduce((sum: number, f: any) => sum + (f.size || 0) / 40, 0); // rough estimate

    dbInst.prepare(`
      UPDATE repositories SET
        file_count = ?, symbol_count = ?, edge_count = ?,
        total_loc = ?, languages = ?, last_indexed_at = datetime('now'),
        index_duration_ms = ?, state = 'indexed'
      WHERE id = ?
    `).run(cbmFiles.length, totalSymbols, totalEdges, Math.round(totalLoc), JSON.stringify([...languages]), durationMs, repoId);

    return {
      repo_name: repoName,
      root_path: repoPath,
      file_count: cbmFiles.length,
      symbol_count: totalSymbols,
      edge_count: totalEdges,
      total_loc: Math.round(totalLoc),
      languages: [...languages],
      index_duration_ms: durationMs,
      indexer: "codebase-memory-mcp (tree-sitter, 155 languages)",
    };
  }

  /**
   * Map CBM edge types to our normalized types.
   */
  private mapEdgeType(cbmType: string): string {
    const map: Record<string, string> = {
      "CALLS": "calls",
      "HTTP_CALLS": "calls",
      "ASYNC_CALLS": "calls",
      "IMPORTS": "imports",
      "INHERITS": "extends",
      "IMPLEMENTS": "implements",
      "DECORATES": "type_ref",
      "USES": "reads",
      "TYPE_OF": "type_ref",
      "TESTS": "tests",
      "SIMILAR_TO": "type_ref",
      "SEMANTICALLY_RELATED": "type_ref",
      "CONFIGURES": "configures",
      "CONTAINS": "imports",
    };
    return map[cbmType] || cbmType.toLowerCase();
  }

  // ═══════════════════════════════════════════════════════════════════
  // BUILT-IN FALLBACK PARSER (regex-based, ~30 languages)
  // Used when the C binary is not installed.
  // ═══════════════════════════════════════════════════════════════════

  private indexViaBuiltinParser(absPath: string, repoName: string): any {
    const dbInst = this.db.instance;
    const startTime = Date.now();

    let repo = dbInst.prepare("SELECT id FROM repositories WHERE root_path = ?").get(absPath) as any;
    if (repo) {
      dbInst.prepare("DELETE FROM symbols WHERE repo_id = ?").run(repo.id);
      dbInst.prepare("DELETE FROM edges WHERE repo_id = ?").run(repo.id);
      dbInst.prepare("DELETE FROM indexed_files WHERE repo_id = ?").run(repo.id);
    } else {
      dbInst.prepare(
        "INSERT INTO repositories (name, root_path, file_count, symbol_count, edge_count, total_loc, languages, last_indexed_at, index_duration_ms, state) VALUES (?, ?, 0, 0, 0, 0, '[]', datetime('now'), 0, 'indexing')"
      ).run(repoName, absPath);
      repo = dbInst.prepare("SELECT id FROM repositories WHERE root_path = ?").get(absPath) as any;
    }
    const repoId = repo.id;

    const files = this.discoverFiles(absPath);
    const languages = new Set<string>();
    let totalLoc = 0;
    let totalSymbols = 0;
    let totalEdges = 0;

    const insertFile = dbInst.prepare(`
      INSERT INTO indexed_files (path, language, byte_size, line_count, content_hash, last_indexed_at, symbol_count, repo_id, state)
      VALUES (?, ?, ?, ?, ?, datetime('now'), 0, ?, 'indexed')
    `);
    const insertSymbol = dbInst.prepare(`
      INSERT INTO symbols (name, fqn, kind, file_path, start_line, end_line, language, signature, docstring, content_hash, byte_size, content_lz4, repo_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?)
    `);
    const insertEdge = dbInst.prepare(`
      INSERT INTO edges (source_fqn, target_fqn, kind, weight, file_path, repo_id)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    const LANGUAGE_MAP: Record<string, string> = {
      ".ts": "typescript", ".tsx": "typescript", ".js": "javascript", ".jsx": "javascript",
      ".py": "python", ".rs": "rust", ".go": "go", ".java": "java",
      ".c": "c", ".h": "c", ".cpp": "cpp", ".cs": "csharp", ".rb": "ruby",
      ".php": "php", ".swift": "swift", ".kt": "kotlin", ".scala": "scala",
    };

    const IGNORE_DIRS = new Set(["node_modules", ".git", "dist", "build", "out", "__pycache__", "target", ".next", "vendor"]);

    const processAll = dbInst.transaction(() => {
      for (const filePath of files) {
        const relativePath = path.relative(absPath, filePath).replace(/\\/g, "/");
        const ext = path.extname(filePath);
        const lang = LANGUAGE_MAP[ext] || "";
        if (lang) languages.add(lang);

        let content: string;
        try { content = fs.readFileSync(filePath, "utf-8"); } catch { continue; }

        const byteSize = Buffer.byteLength(content);
        const lineCount = content.split("\n").length;
        const contentHash = crypto.createHash("sha256").update(content).digest("hex").slice(0, 16);
        totalLoc += lineCount;

        insertFile.run(relativePath, lang, byteSize, lineCount, contentHash, repoId);

        const { symbols, edges } = this.parseFile(content, relativePath, lang, repoName);
        for (const sym of symbols) {
          insertSymbol.run(sym.name, sym.fqn, sym.kind, relativePath, sym.start_line, sym.end_line, lang, sym.signature, sym.docstring, contentHash, sym.byte_size, repoId);
          totalSymbols++;
        }
        for (const edge of edges) {
          insertEdge.run(edge.source_fqn, edge.target_fqn, edge.kind, edge.weight, relativePath, repoId);
          totalEdges++;
        }
      }
    });
    processAll();

    const durationMs = Date.now() - startTime;
    dbInst.prepare(`
      UPDATE repositories SET file_count = ?, symbol_count = ?, edge_count = ?, total_loc = ?, languages = ?, last_indexed_at = datetime('now'), index_duration_ms = ?, state = 'indexed' WHERE id = ?
    `).run(files.length, totalSymbols, totalEdges, totalLoc, JSON.stringify([...languages]), durationMs, repoId);

    return {
      repo_name: repoName,
      root_path: absPath,
      file_count: files.length,
      symbol_count: totalSymbols,
      edge_count: totalEdges,
      total_loc: totalLoc,
      languages: [...languages],
      index_duration_ms: durationMs,
      indexer: "built-in (regex, ~30 languages). Install codebase-memory-mcp for 155-language tree-sitter support.",
    };
  }

  async listRepos(): Promise<any> {
    const dbInst = this.db.instance;
    const repos = dbInst.prepare("SELECT * FROM repositories ORDER BY name").all() as any[];
    return {
      repos: repos.map((r: any) => ({
        name: r.name, root_path: r.root_path, file_count: r.file_count,
        symbol_count: r.symbol_count, edge_count: r.edge_count, total_loc: r.total_loc,
        languages: JSON.parse(r.languages || "[]"), last_indexed_at: r.last_indexed_at,
        index_duration_ms: r.index_duration_ms, state: r.state,
      })),
      total: repos.length,
    };
  }

  async getRepoStats(repoName: string): Promise<any> {
    const dbInst = this.db.instance;
    const repo = dbInst.prepare("SELECT * FROM repositories WHERE name = ?").get(repoName) as any;
    if (!repo) throw new Error(`Repository not found: ${repoName}`);

    const kinds = dbInst.prepare("SELECT kind, COUNT(*) as count FROM symbols WHERE repo_id = ? GROUP BY kind ORDER BY count DESC").all(repo.id) as any[];
    const langs = dbInst.prepare("SELECT language, COUNT(*) as count FROM indexed_files WHERE repo_id = ? AND language != '' GROUP BY language ORDER BY count DESC").all(repo.id) as any[];
    const edgeTypes = dbInst.prepare("SELECT kind, COUNT(*) as count FROM edges WHERE repo_id = ? GROUP BY kind ORDER BY count DESC").all(repo.id) as any[];
    const topSymbols = dbInst.prepare(`
      SELECT s.name, s.fqn, s.kind,
        (SELECT COUNT(*) FROM edges WHERE source_fqn = s.fqn OR target_fqn = s.fqn) as connections
      FROM symbols s WHERE s.repo_id = ? ORDER BY connections DESC LIMIT 10
    `).all(repo.id) as any[];

    return {
      ...repo, languages: JSON.parse(repo.languages || "[]"),
      symbol_kinds: kinds, language_distribution: langs,
      edge_types: edgeTypes, top_connected_symbols: topSymbols,
    };
  }

  // ─── File discovery ─────────────────────────────────────────────

  private discoverFiles(rootPath: string): string[] {
    const IGNORE_DIRS = new Set(["node_modules", ".git", "dist", "build", "out", "__pycache__", "target", ".next", "vendor"]);
    const LANGUAGE_MAP: Record<string, boolean> = { ".ts": true, ".tsx": true, ".js": true, ".jsx": true, ".py": true, ".rs": true, ".go": true, ".java": true, ".c": true, ".h": true, ".cpp": true, ".cs": true, ".rb": true, ".php": true, ".swift": true, ".kt": true };
    const files: string[] = [];
    const walk = (dir: string) => {
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (entry.name.startsWith(".")) continue;
        if (IGNORE_DIRS.has(entry.name) && entry.isDirectory()) continue;
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(fullPath);
        else if (entry.isFile() && LANGUAGE_MAP[path.extname(entry.name)]) files.push(fullPath);
      }
    };
    walk(rootPath);
    return files;
  }

  // ─── Regex-based parser (fallback) ──────────────────────────────

  private parseFile(content: string, filePath: string, lang: string, repoName: string): { symbols: any[]; edges: any[] } {
    const modulePrefix = `${repoName}.${filePath.replace(/\.[^.]+$/, "").replace(/[/\\]/g, ".")}`;
    const symbols: any[] = [];
    const edges: any[] = [];
    const lines = content.split("\n");

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNum = i + 1;

      // Class/Interface
      const classMatch = line.match(/^(?:export\s+)?(?:abstract\s+)?(?:class|interface)\s+(\w+)/);
      if (classMatch) {
        const endLine = this.findBlockEnd(lines, i);
        symbols.push({ name: classMatch[1], fqn: `${modulePrefix}.${classMatch[1]}`, kind: "class", start_line: lineNum, end_line: endLine, signature: line.trim(), docstring: "", byte_size: lines.slice(i, endLine).join("\n").length });
        continue;
      }

      // Function
      const funcMatch = line.match(/^(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*(?:<[^>]*>)?\s*\(([^)]*)\)/);
      if (funcMatch) {
        const endLine = this.findBlockEnd(lines, i);
        symbols.push({ name: funcMatch[1], fqn: `${modulePrefix}.${funcMatch[1]}`, kind: "function", start_line: lineNum, end_line: endLine, signature: `${funcMatch[1]}(${funcMatch[2]})`, docstring: "", byte_size: lines.slice(i, endLine).join("\n").length });
        continue;
      }

      // Python class/def
      const pyClassMatch = line.match(/^class\s+(\w+)/);
      if (pyClassMatch) {
        symbols.push({ name: pyClassMatch[1], fqn: `${modulePrefix}.${pyClassMatch[1]}`, kind: "class", start_line: lineNum, end_line: lineNum + 20, signature: line.trim(), docstring: "", byte_size: 400 });
        continue;
      }
      const pyFuncMatch = line.match(/^(?:\s*)(?:async\s+)?def\s+(\w+)/);
      if (pyFuncMatch) {
        symbols.push({ name: pyFuncMatch[1], fqn: `${modulePrefix}.${pyFuncMatch[1]}`, kind: "function", start_line: lineNum, end_line: lineNum + 10, signature: line.trim(), docstring: "", byte_size: 200 });
        continue;
      }

      // Imports (for edge generation)
      const importMatch = line.match(/import\s+(?:\{([^}]+)\}|(\w+))\s+from\s+['"](.*?)['"]/);
      if (importMatch && symbols.length > 0) {
        const names = importMatch[1] ? importMatch[1].split(",").map(s => s.trim().split(" as ")[0].trim()) : [importMatch[2]];
        const from = importMatch[3];
        for (const name of names) {
          if (name) edges.push({ source_fqn: symbols[0].fqn, target_fqn: `${from.replace(/[./\\]/g, ".")}.${name}`, kind: "imports", weight: 0.8 });
        }
      }
    }

    return { symbols, edges };
  }

  private findBlockEnd(lines: string[], startIdx: number): number {
    let braceCount = 0; let started = false;
    for (let i = startIdx; i < lines.length; i++) {
      for (const ch of lines[i]) {
        if (ch === "{") { braceCount++; started = true; }
        if (ch === "}") braceCount--;
        if (started && braceCount === 0) return i + 1;
      }
    }
    return Math.min(startIdx + 50, lines.length);
  }
}
