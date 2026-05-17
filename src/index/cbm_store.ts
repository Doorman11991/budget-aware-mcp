// CBM Store — Direct read access to DeusData codebase-memory-mcp SQLite databases.
//
// Instead of importing CBM's data into our own DB (lossy — edges get dropped),
// we query their .db files directly. This gives us the full 4117-edge graph
// instead of the 142 we get through import.
//
// CBM Schema:
//   nodes(id, project, label, name, qualified_name, file_path, start_line, end_line, properties)
//   edges(id, project, source_id, target_id, type, properties)
//   file_hashes(project, rel_path, sha256, mtime_ns, size)
//   projects(name, indexed_at, root_path)

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import Database from "better-sqlite3";

function getCbmCacheDir(): string {
  if (process.platform === "win32") {
    // CBM uses ~/.cache on all platforms
    const homeCache = path.join(os.homedir(), ".cache", "codebase-memory-mcp");
    if (fs.existsSync(homeCache)) return homeCache;
    // Fallback to LOCALAPPDATA
    return path.join(
      process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
      "codebase-memory-mcp"
    );
  }
  return path.join(
    process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"),
    "codebase-memory-mcp"
  );
}

export interface CbmNode {
  id: number;
  name: string;
  qualified_name: string;
  label: string;
  file_path: string;
  start_line: number;
  end_line: number;
  properties: string;
}

export interface CbmEdge {
  source_id: number;
  target_id: number;
  type: string;
}

/**
 * Direct read-only access to a CBM project database.
 * Opens the .db file from ~/.cache/codebase-memory-mcp/<project>.db
 */
export class CbmStore {
  private dbs = new Map<string, Database.Database>();

  /**
   * List all CBM-indexed projects.
   */
  listProjects(): { name: string; root_path: string; db_path: string }[] {
    const cacheDir = getCbmCacheDir();
    if (!fs.existsSync(cacheDir)) return [];

    const results: { name: string; root_path: string; db_path: string }[] = [];
    const files = fs.readdirSync(cacheDir).filter(f => f.endsWith(".db"));

    for (const file of files) {
      const dbPath = path.join(cacheDir, file);
      try {
        const db = this.openDb(dbPath);
        const project = db.prepare("SELECT name, root_path FROM projects LIMIT 1").get() as any;
        if (project) {
          results.push({ name: project.name, root_path: project.root_path, db_path: dbPath });
        }
      } catch { /* skip corrupted dbs */ }
    }

    return results;
  }

  /**
   * Find the DB for a project by name or path.
   */
  findDb(nameOrPath: string): Database.Database | null {
    const cacheDir = getCbmCacheDir();
    if (!fs.existsSync(cacheDir)) return null;

    // Try direct name match
    const directPath = path.join(cacheDir, `${nameOrPath}.db`);
    if (fs.existsSync(directPath)) return this.openDb(directPath);

    // Scan all .db files for matching project name or root_path
    const files = fs.readdirSync(cacheDir).filter(f => f.endsWith(".db"));
    for (const file of files) {
      const dbPath = path.join(cacheDir, file);
      try {
        const db = this.openDb(dbPath);
        const project = db.prepare("SELECT name, root_path FROM projects WHERE name = ? OR root_path LIKE ?").get(nameOrPath, `%${nameOrPath}%`) as any;
        if (project) return db;
      } catch { continue; }
    }

    return null;
  }

  /**
   * Find a DB that contains a given file path.
   */
  findDbByFilePath(filePath: string): Database.Database | null {
    const cacheDir = getCbmCacheDir();
    if (!fs.existsSync(cacheDir)) return null;

    const files = fs.readdirSync(cacheDir).filter(f => f.endsWith(".db"));
    for (const file of files) {
      const dbPath = path.join(cacheDir, file);
      try {
        const db = this.openDb(dbPath);
        const match = db.prepare("SELECT 1 FROM nodes WHERE file_path LIKE ? LIMIT 1").get(`%${path.basename(filePath)}%`);
        if (match) return db;
      } catch { continue; }
    }
    return null;
  }

  /**
   * Get all nodes from a project DB.
   */
  getNodes(db: Database.Database, project?: string): CbmNode[] {
    if (project) {
      return db.prepare("SELECT id, name, qualified_name, label, file_path, start_line, end_line, properties FROM nodes WHERE project = ?").all(project) as CbmNode[];
    }
    return db.prepare("SELECT id, name, qualified_name, label, file_path, start_line, end_line, properties FROM nodes").all() as CbmNode[];
  }

  /**
   * Get all edges from a project DB.
   */
  getEdges(db: Database.Database, project?: string): CbmEdge[] {
    if (project) {
      return db.prepare("SELECT source_id, target_id, type FROM edges WHERE project = ?").all(project) as CbmEdge[];
    }
    return db.prepare("SELECT source_id, target_id, type FROM edges").all() as CbmEdge[];
  }

  /**
   * BFS graph walk directly on CBM's database.
   * This is the key function — walks CBM's edge table directly.
   */
  graphWalk(db: Database.Database, anchorName: string, hopDepth: number, maxTokens: number): any {
    // Resolve anchor to node(s)
    const anchors = db.prepare(
      "SELECT id, name, qualified_name, label, file_path, start_line, end_line FROM nodes WHERE name = ? OR qualified_name LIKE ? ORDER BY qualified_name LIMIT 10"
    ).all(anchorName, `%${anchorName}%`) as any[];

    if (anchors.length === 0) {
      return { symbols: [], files: [], hops_traversed: 0, tokens_returned: 0, tokens_saved_vs_full_read: 0 };
    }

    const visited = new Set<number>();
    const collected: any[] = [];
    let currentLevel = anchors.map((a: any) => a.id);
    let tokensUsed = 0;
    let hopsTraversed = 0;

    // Prepare statements for BFS
    const getNode = db.prepare("SELECT id, name, qualified_name, label, file_path, start_line, end_line FROM nodes WHERE id = ?");
    const getOutEdges = db.prepare("SELECT target_id FROM edges WHERE source_id = ? AND type IN ('CALLS','IMPORTS','DEFINES_METHOD','USAGE','HTTP_CALLS') ORDER BY target_id");
    const getInEdges = db.prepare("SELECT source_id FROM edges WHERE target_id = ? AND type IN ('CALLS','IMPORTS','USAGE','HTTP_CALLS') ORDER BY source_id");

    for (let hop = 0; hop <= hopDepth && currentLevel.length > 0; hop++) {
      currentLevel.sort((a, b) => a - b); // deterministic ordering
      const nextLevel: number[] = [];

      for (const nodeId of currentLevel) {
        if (visited.has(nodeId)) continue;
        visited.add(nodeId);

        const node = getNode.get(nodeId) as any;
        if (!node) continue;

        // Skip structural nodes (Project, Folder, File, Module, Package)
        if (["Project", "Folder", "File"].includes(node.label)) continue;

        // Estimate tokens: ~50 tokens per symbol minimum
        const tokenCost = Math.max(50, Math.ceil((node.end_line - node.start_line) * 10));
        if (tokensUsed + tokenCost > maxTokens && collected.length > 0) continue;

        tokensUsed += tokenCost;
        collected.push({
          name: node.name,
          fqn: node.qualified_name,
          kind: node.label.toLowerCase(),
          file_path: node.file_path || "",
          start_line: node.start_line,
          end_line: node.end_line,
          hop_distance: hop,
        });

        // Get connected nodes for next hop
        if (hop < hopDepth) {
          const outEdges = getOutEdges.all(nodeId) as any[];
          for (const e of outEdges) {
            if (!visited.has(e.target_id)) nextLevel.push(e.target_id);
          }
          const inEdges = getInEdges.all(nodeId) as any[];
          for (const e of inEdges) {
            if (!visited.has(e.source_id)) nextLevel.push(e.source_id);
          }
        }
      }

      if (hop > 0 || anchors.length > 0) hopsTraversed = hop;
      currentLevel = [...new Set(nextLevel)];
    }

    // Aggregate files
    const fileMap = new Map<string, number>();
    for (const sym of collected) {
      if (sym.file_path) {
        fileMap.set(sym.file_path, (fileMap.get(sym.file_path) || 0) + 1);
      }
    }

    const files = [...fileMap.entries()]
      .map(([p, count]) => ({ path: p, symbols_included: count }))
      .sort((a, b) => a.path.localeCompare(b.path));

    return {
      symbols: collected,
      files,
      hops_traversed: hopsTraversed,
      tokens_returned: tokensUsed,
      tokens_saved_vs_full_read: Math.max(0, collected.length * 200 - tokensUsed),
    };
  }

  /**
   * Fuzzy symbol search directly on CBM's database.
   */
  fuzzyFind(db: Database.Database, query: string, maxResults: number): any[] {
    const lowerQuery = query.toLowerCase();

    // Exact name match
    let results = db.prepare(
      "SELECT name, qualified_name as fqn, label as kind, file_path, start_line, end_line FROM nodes WHERE LOWER(name) = ? AND label NOT IN ('Project','Folder','File') ORDER BY name LIMIT ?"
    ).all(lowerQuery, maxResults) as any[];

    if (results.length >= maxResults) return results;

    // Prefix match
    const more = db.prepare(
      "SELECT name, qualified_name as fqn, label as kind, file_path, start_line, end_line FROM nodes WHERE LOWER(name) LIKE ? AND label NOT IN ('Project','Folder','File') ORDER BY name LIMIT ?"
    ).all(`${lowerQuery}%`, maxResults - results.length) as any[];
    results = [...results, ...more];

    if (results.length >= maxResults) return this.dedupeByFqn(results, maxResults);

    // Contains match
    const contains = db.prepare(
      "SELECT name, qualified_name as fqn, label as kind, file_path, start_line, end_line FROM nodes WHERE (LOWER(name) LIKE ? OR LOWER(qualified_name) LIKE ?) AND label NOT IN ('Project','Folder','File') ORDER BY name LIMIT ?"
    ).all(`%${lowerQuery}%`, `%${lowerQuery}%`, maxResults - results.length) as any[];
    results = [...results, ...contains];

    return this.dedupeByFqn(results, maxResults);
  }

  /**
   * Trace shortest path between two symbols.
   */
  tracePath(db: Database.Database, fromName: string, toName: string, maxHops: number): any {
    const fromNodes = db.prepare("SELECT id, name, qualified_name, label FROM nodes WHERE name = ? OR qualified_name LIKE ? LIMIT 5").all(fromName, `%${fromName}%`) as any[];
    const toNodes = db.prepare("SELECT id, name, qualified_name, label FROM nodes WHERE name = ? OR qualified_name LIKE ? LIMIT 5").all(toName, `%${toName}%`) as any[];

    if (fromNodes.length === 0 || toNodes.length === 0) {
      return { found: false, path: [], hops: 0 };
    }

    const targetIds = new Set(toNodes.map((n: any) => n.id));
    const queue: { id: number; path: any[] }[] = fromNodes.map((n: any) => ({
      id: n.id,
      path: [{ name: n.name, fqn: n.qualified_name, kind: n.label }],
    }));
    const visited = new Set(fromNodes.map((n: any) => n.id));

    const getOutEdges = db.prepare("SELECT target_id, type FROM edges WHERE source_id = ?");
    const getNode = db.prepare("SELECT id, name, qualified_name, label FROM nodes WHERE id = ?");

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current.path.length > maxHops + 1) break;

      if (targetIds.has(current.id) && current.path.length > 1) {
        return { found: true, path: current.path, hops: current.path.length - 1 };
      }

      const edges = getOutEdges.all(current.id) as any[];
      for (const edge of edges) {
        if (!visited.has(edge.target_id)) {
          visited.add(edge.target_id);
          const node = getNode.get(edge.target_id) as any;
          if (node) {
            queue.push({
              id: edge.target_id,
              path: [...current.path, { name: node.name, fqn: node.qualified_name, kind: node.label, via: edge.type }],
            });
          }
        }
      }
    }

    return { found: false, path: [], hops: 0 };
  }

  /**
   * Impact analysis on CBM's database.
   */
  analyzeImpact(db: Database.Database, changedFiles: string[], hopDepth: number): any {
    const affectedNodeIds: number[] = [];

    for (const file of changedFiles) {
      const nodes = db.prepare("SELECT id FROM nodes WHERE file_path LIKE ?").all(`%${file}%`) as any[];
      for (const n of nodes) affectedNodeIds.push(n.id);
    }

    if (affectedNodeIds.length === 0) {
      return { changed_symbols: 0, blast_radius: 0, affected_files: [] };
    }

    // Walk inbound edges (things that depend on changed symbols)
    const blastRadius = new Set<number>();
    let currentLevel = [...affectedNodeIds];
    const visited = new Set(affectedNodeIds);

    const getInEdges = db.prepare("SELECT source_id FROM edges WHERE target_id = ? AND type IN ('CALLS','IMPORTS','USAGE')");

    for (let hop = 0; hop < hopDepth; hop++) {
      const nextLevel: number[] = [];
      for (const nodeId of currentLevel) {
        const edges = getInEdges.all(nodeId) as any[];
        for (const e of edges) {
          if (!visited.has(e.source_id)) {
            visited.add(e.source_id);
            nextLevel.push(e.source_id);
            blastRadius.add(e.source_id);
          }
        }
      }
      currentLevel = nextLevel;
    }

    // Get file paths
    const affectedFiles = new Set<string>();
    for (const nodeId of blastRadius) {
      const node = db.prepare("SELECT file_path FROM nodes WHERE id = ?").get(nodeId) as any;
      if (node?.file_path) affectedFiles.add(node.file_path);
    }

    return {
      changed_symbols: affectedNodeIds.length,
      blast_radius: blastRadius.size,
      affected_files: [...affectedFiles].sort(),
      total_affected_files: affectedFiles.size,
    };
  }

  /**
   * Discover subsystems.
   */
  discoverSubsystems(db: Database.Database, maxClusters: number): any {
    const symbols = db.prepare(`
      SELECT n.id, n.name, n.qualified_name, n.label, n.file_path,
        (SELECT COUNT(*) FROM edges WHERE source_id = n.id) as out_degree,
        (SELECT COUNT(*) FROM edges WHERE target_id = n.id) as in_degree
      FROM nodes n
      WHERE n.label NOT IN ('Project', 'Folder', 'File', 'Module', 'Package')
      ORDER BY (SELECT COUNT(*) FROM edges WHERE source_id = n.id) + (SELECT COUNT(*) FROM edges WHERE target_id = n.id) DESC
      LIMIT 200
    `).all() as any[];

    // Group by directory
    const dirGroups = new Map<string, any[]>();
    for (const sym of symbols) {
      const dir = (sym.file_path || "").split(/[/\\]/).slice(0, -1).join("/") || "(root)";
      const group = dirGroups.get(dir) || [];
      group.push(sym);
      dirGroups.set(dir, group);
    }

    const clusters = [...dirGroups.entries()]
      .map(([dir, syms]) => ({
        directory: dir,
        symbol_count: syms.length,
        total_connectivity: syms.reduce((sum: number, s: any) => sum + s.out_degree + s.in_degree, 0),
        entry_points: syms
          .sort((a: any, b: any) => (b.in_degree + b.out_degree) - (a.in_degree + a.out_degree))
          .slice(0, 3)
          .map((s: any) => ({ name: s.name, fqn: s.qualified_name, kind: s.label, connectivity: s.in_degree + s.out_degree })),
      }))
      .sort((a, b) => b.total_connectivity - a.total_connectivity)
      .slice(0, maxClusters);

    return { clusters, total_symbols: symbols.length };
  }

  private openDb(dbPath: string): Database.Database {
    if (!this.dbs.has(dbPath)) {
      const instance = new Database(dbPath, { readonly: true });
      instance.pragma("journal_mode = WAL");
      this.dbs.set(dbPath, instance);
    }
    return this.dbs.get(dbPath)!;
  }

  private dedupeByFqn(results: any[], max: number): any[] {
    const seen = new Set<string>();
    const unique: any[] = [];
    for (const r of results) {
      if (!seen.has(r.fqn)) {
        seen.add(r.fqn);
        unique.push(r);
        if (unique.length >= max) break;
      }
    }
    return unique;
  }

  close() {
    for (const db of this.dbs.values()) {
      try { db.close(); } catch {}
    }
    this.dbs.clear();
  }
}
