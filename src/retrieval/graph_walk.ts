// Graph Walk — the core retrieval algorithm.
// BFS from anchor symbols, hop along import/call/inheritance edges,
// collect symbols until token budget is hit.
// Deterministic: alphabetical ordering within each hop level.

interface WalkResult {
  symbols: SymbolResult[];
  files: FileResult[];
  hops_traversed: number;
  tokens_returned: number;
  tokens_saved_vs_full_read: number;
}

interface SymbolResult {
  name: string;
  fqn: string;
  kind: string;
  file_path: string;
  start_line: number;
  end_line: number;
  signature: string;
  hop_distance: number;
}

interface FileResult {
  path: string;
  symbols_included: number;
  byte_size: number;
}

interface PathResult {
  found: boolean;
  path: { fqn: string; kind: string; via_edge: string }[];
  hops: number;
}

export class GraphWalker {
  constructor(private db: any) {}

  /**
   * BFS walk from an anchor symbol. Collects connected symbols until
   * the token budget is exhausted.
   *
   * Token estimation: symbol byte_size / 4 (conservative char-to-token ratio)
   */
  async walk(anchor: string, hopDepth: number, maxTokens: number): Promise<WalkResult> {
    const dbInst = this.db.instance;

    // Resolve anchor to FQN(s)
    const anchors = this.resolveAnchor(anchor);
    if (anchors.length === 0) {
      return { symbols: [], files: [], hops_traversed: 0, tokens_returned: 0, tokens_saved_vs_full_read: 0 };
    }

    const visited = new Set<string>();
    const collected: (SymbolResult & { byte_size: number })[] = [];
    let currentLevel = anchors.map(a => a.fqn);
    let tokensUsed = 0;
    let hopsTraversed = 0;

    for (let hop = 0; hop <= hopDepth && currentLevel.length > 0; hop++) {
      // Sort current level alphabetically for determinism
      currentLevel.sort();

      const nextLevel: string[] = [];

      for (const fqn of currentLevel) {
        if (visited.has(fqn)) continue;
        visited.add(fqn);

        // Get symbol details
        const sym = dbInst.prepare(
          "SELECT name, fqn, kind, file_path, start_line, end_line, signature, byte_size FROM symbols WHERE fqn = ?"
        ).get(fqn) as any;

        if (!sym) continue;

        // Check token budget
        const tokenCost = Math.ceil(sym.byte_size / 4) || 50; // minimum 50 tokens per symbol
        if (tokensUsed + tokenCost > maxTokens && collected.length > 0) {
          // Budget exceeded — stop adding
          continue;
        }

        tokensUsed += tokenCost;
        collected.push({
          name: sym.name,
          fqn: sym.fqn,
          kind: sym.kind,
          file_path: sym.file_path,
          start_line: sym.start_line,
          end_line: sym.end_line,
          signature: sym.signature,
          byte_size: sym.byte_size,
          hop_distance: hop,
        });

        // Get outgoing edges for next hop
        if (hop < hopDepth) {
          const edges = dbInst.prepare(
            "SELECT target_fqn FROM edges WHERE source_fqn = ? ORDER BY target_fqn"
          ).all(fqn) as any[];

          for (const edge of edges) {
            if (!visited.has(edge.target_fqn)) {
              nextLevel.push(edge.target_fqn);
            }
          }

          // Also walk incoming edges (callers/importers)
          const inEdges = dbInst.prepare(
            "SELECT source_fqn FROM edges WHERE target_fqn = ? ORDER BY source_fqn"
          ).all(fqn) as any[];

          for (const edge of inEdges) {
            if (!visited.has(edge.source_fqn)) {
              nextLevel.push(edge.source_fqn);
            }
          }
        }
      }

      if (hop > 0 || anchors.length > 0) hopsTraversed = hop;
      currentLevel = [...new Set(nextLevel)];
    }

    // Aggregate by file
    const fileMap = new Map<string, { symbols_included: number; byte_size: number }>();
    for (const sym of collected) {
      const existing = fileMap.get(sym.file_path) || { symbols_included: 0, byte_size: 0 };
      existing.symbols_included++;
      existing.byte_size += sym.byte_size;
      fileMap.set(sym.file_path, existing);
    }

    // Calculate tokens saved vs reading all files fully
    let totalFileBytes = 0;
    for (const filePath of fileMap.keys()) {
      const file = dbInst.prepare("SELECT byte_size FROM indexed_files WHERE path = ?").get(filePath) as any;
      if (file) totalFileBytes += file.byte_size;
    }
    const tokensSaved = Math.max(0, Math.ceil(totalFileBytes / 4) - tokensUsed);

    const files: FileResult[] = [...fileMap.entries()]
      .map(([path, data]) => ({ path, ...data }))
      .sort((a, b) => a.path.localeCompare(b.path));

    return {
      symbols: collected.map(({ byte_size, ...rest }) => rest),
      files,
      hops_traversed: hopsTraversed,
      tokens_returned: tokensUsed,
      tokens_saved_vs_full_read: tokensSaved,
    };
  }

  /**
   * Find shortest path between two symbols via BFS on edges.
   */
  async tracePath(fromSymbol: string, toSymbol: string, maxHops: number): Promise<PathResult> {
    const dbInst = this.db.instance;

    const fromAnchors = this.resolveAnchor(fromSymbol);
    const toAnchors = this.resolveAnchor(toSymbol);

    if (fromAnchors.length === 0 || toAnchors.length === 0) {
      return { found: false, path: [], hops: 0 };
    }

    const targetFqns = new Set(toAnchors.map(a => a.fqn));
    const queue: { fqn: string; path: { fqn: string; kind: string; via_edge: string }[] }[] =
      fromAnchors.map(a => ({ fqn: a.fqn, path: [{ fqn: a.fqn, kind: a.kind, via_edge: "start" }] }));
    const visited = new Set<string>(fromAnchors.map(a => a.fqn));

    while (queue.length > 0) {
      const current = queue.shift()!;

      if (current.path.length > maxHops + 1) break;

      if (targetFqns.has(current.fqn) && current.path.length > 1) {
        return { found: true, path: current.path, hops: current.path.length - 1 };
      }

      const edges = dbInst.prepare(
        "SELECT target_fqn, kind FROM edges WHERE source_fqn = ? ORDER BY target_fqn"
      ).all(current.fqn) as any[];

      for (const edge of edges) {
        if (!visited.has(edge.target_fqn)) {
          visited.add(edge.target_fqn);
          const sym = dbInst.prepare("SELECT kind FROM symbols WHERE fqn = ?").get(edge.target_fqn) as any;
          queue.push({
            fqn: edge.target_fqn,
            path: [...current.path, { fqn: edge.target_fqn, kind: sym?.kind || "unknown", via_edge: edge.kind }],
          });
        }
      }
    }

    return { found: false, path: [], hops: 0 };
  }

  /**
   * Impact analysis: find all symbols affected by changes to the given files.
   */
  async analyzeImpact(changedFiles: string[], hopDepth: number): Promise<any> {
    const dbInst = this.db.instance;

    // Find all symbols in changed files
    const affectedSymbols: string[] = [];
    for (const filePath of changedFiles) {
      const syms = dbInst.prepare(
        "SELECT fqn FROM symbols WHERE file_path LIKE ?"
      ).all(`%${filePath}`) as any[];
      for (const s of syms) affectedSymbols.push(s.fqn);
    }

    if (affectedSymbols.length === 0) {
      return { changed_symbols: [], blast_radius: [], total_affected_files: 0 };
    }

    // Walk outward from affected symbols to find blast radius
    const blastRadius = new Set<string>();
    let currentLevel = [...affectedSymbols];
    const visited = new Set<string>(affectedSymbols);

    for (let hop = 0; hop < hopDepth; hop++) {
      const nextLevel: string[] = [];
      for (const fqn of currentLevel) {
        // Find everything that depends on this symbol (incoming edges)
        const dependents = dbInst.prepare(
          "SELECT source_fqn FROM edges WHERE target_fqn = ?"
        ).all(fqn) as any[];

        for (const dep of dependents) {
          if (!visited.has(dep.source_fqn)) {
            visited.add(dep.source_fqn);
            nextLevel.push(dep.source_fqn);
            blastRadius.add(dep.source_fqn);
          }
        }
      }
      currentLevel = nextLevel;
    }

    // Get file paths for blast radius
    const affectedFiles = new Set<string>();
    for (const fqn of blastRadius) {
      const sym = dbInst.prepare("SELECT file_path FROM symbols WHERE fqn = ?").get(fqn) as any;
      if (sym) affectedFiles.add(sym.file_path);
    }

    return {
      changed_symbols: affectedSymbols.sort(),
      blast_radius: [...blastRadius].sort(),
      affected_files: [...affectedFiles].sort(),
      total_affected_files: affectedFiles.size,
      total_affected_symbols: blastRadius.size,
    };
  }

  /**
   * Resolve an anchor string to symbol FQNs. Tries exact FQN match first,
   * then name match, then fuzzy.
   */
  private resolveAnchor(anchor: string): { fqn: string; kind: string }[] {
    const dbInst = this.db.instance;

    // Exact FQN match
    let results = dbInst.prepare(
      "SELECT fqn, kind FROM symbols WHERE fqn = ? LIMIT 10"
    ).all(anchor) as any[];
    if (results.length > 0) return results;

    // Exact name match
    results = dbInst.prepare(
      "SELECT fqn, kind FROM symbols WHERE name = ? ORDER BY fqn LIMIT 10"
    ).all(anchor) as any[];
    if (results.length > 0) return results;

    // Case-insensitive name match
    results = dbInst.prepare(
      "SELECT fqn, kind FROM symbols WHERE LOWER(name) = LOWER(?) ORDER BY fqn LIMIT 10"
    ).all(anchor) as any[];
    if (results.length > 0) return results;

    // Partial match (contains)
    results = dbInst.prepare(
      "SELECT fqn, kind FROM symbols WHERE name LIKE ? OR fqn LIKE ? ORDER BY fqn LIMIT 10"
    ).all(`%${anchor}%`, `%${anchor}%`) as any[];

    return results;
  }
}
