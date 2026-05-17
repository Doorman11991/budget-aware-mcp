// Structural Similarity — find code shaped like X without embeddings.
// Matches by method-name patterns and type signatures.

export class SimilarityFinder {
  constructor(private db: any) {}

  /**
   * Find symbols structurally similar to the source.
   * Compares: kind, signature pattern, method-name patterns for classes.
   */
  async find(sourceSymbol: string, maxResults: number): Promise<any> {
    const dbInst = this.db.instance;

    // Resolve source symbol
    const source = dbInst.prepare(
      "SELECT name, fqn, kind, file_path, signature FROM symbols WHERE fqn = ? OR name = ? LIMIT 1"
    ).get(sourceSymbol, sourceSymbol) as any;

    if (!source) {
      return { source: sourceSymbol, matches: [], message: "Source symbol not found" };
    }

    let matches: any[] = [];

    if (source.kind === "class" || source.kind === "interface") {
      // For classes: find other classes with similar method names
      matches = await this.findSimilarClasses(source);
    } else if (source.kind === "function" || source.kind === "method") {
      // For functions: find functions with similar signature patterns
      matches = await this.findSimilarFunctions(source);
    } else {
      // Generic: same kind, similar name length, in similar file paths
      matches = dbInst.prepare(
        "SELECT name, fqn, kind, file_path, signature FROM symbols WHERE kind = ? AND fqn != ? ORDER BY name LIMIT ?"
      ).all(source.kind, source.fqn, maxResults) as any[];
    }

    return {
      source: { name: source.name, fqn: source.fqn, kind: source.kind },
      matches: matches.slice(0, maxResults).map((m: any) => ({
        name: m.name,
        fqn: m.fqn,
        kind: m.kind,
        file_path: m.file_path,
        similarity_reason: m.reason || "same_kind",
      })),
    };
  }

  private async findSimilarClasses(source: any): Promise<any[]> {
    const dbInst = this.db.instance;

    // Get methods of source class
    const sourceMethods = dbInst.prepare(
      "SELECT name FROM symbols WHERE kind = 'method' AND fqn LIKE ?"
    ).all(`${source.fqn}.%`) as any[];

    const methodNames = sourceMethods.map((m: any) => m.name.toLowerCase());

    if (methodNames.length === 0) {
      // No methods — fall back to name similarity
      return dbInst.prepare(
        "SELECT name, fqn, kind, file_path, signature FROM symbols WHERE kind IN ('class', 'interface') AND fqn != ? LIMIT 20"
      ).all(source.fqn) as any[];
    }

    // Find other classes and score by method name overlap
    const otherClasses = dbInst.prepare(
      "SELECT DISTINCT fqn, name, kind, file_path, signature FROM symbols WHERE kind IN ('class', 'interface') AND fqn != ?"
    ).all(source.fqn) as any[];

    const scored: any[] = [];
    for (const cls of otherClasses) {
      const clsMethods = dbInst.prepare(
        "SELECT name FROM symbols WHERE kind = 'method' AND fqn LIKE ?"
      ).all(`${cls.fqn}.%`) as any[];

      const clsMethodNames = clsMethods.map((m: any) => m.name.toLowerCase());
      const overlap = methodNames.filter(m => clsMethodNames.includes(m)).length;

      if (overlap > 0) {
        scored.push({
          ...cls,
          score: overlap / Math.max(methodNames.length, clsMethodNames.length),
          reason: `${overlap}/${methodNames.length} matching method names`,
        });
      }
    }

    return scored.sort((a, b) => b.score - a.score);
  }

  private async findSimilarFunctions(source: any): Promise<any[]> {
    const dbInst = this.db.instance;

    // Match by signature pattern
    if (source.signature) {
      // Extract param count from signature
      const paramCount = (source.signature.match(/,/g) || []).length + 1;

      const similar = dbInst.prepare(`
        SELECT name, fqn, kind, file_path, signature FROM symbols
        WHERE kind IN ('function', 'method')
          AND fqn != ?
          AND LENGTH(signature) > 0
        LIMIT 100
      `).all(source.fqn) as any[];

      // Score by signature similarity
      return similar
        .map((s: any) => {
          const sParamCount = (s.signature.match(/,/g) || []).length + 1;
          const paramSimilarity = 1 - Math.abs(paramCount - sParamCount) / Math.max(paramCount, sParamCount);
          return { ...s, score: paramSimilarity, reason: `similar_arity(${sParamCount} params)` };
        })
        .filter((s: any) => s.score > 0.5)
        .sort((a: any, b: any) => b.score - a.score);
    }

    // Fallback: same kind, similar name pattern
    const nameTokens = source.name.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase().split("_");
    const results: any[] = [];

    for (const token of nameTokens) {
      if (token.length < 3) continue;
      const matches = dbInst.prepare(
        "SELECT name, fqn, kind, file_path, signature FROM symbols WHERE kind IN ('function', 'method') AND LOWER(name) LIKE ? AND fqn != ? LIMIT 10"
      ).all(`%${token}%`, source.fqn) as any[];
      results.push(...matches.map((m: any) => ({ ...m, reason: `name_contains:${token}` })));
    }

    return results;
  }
}
