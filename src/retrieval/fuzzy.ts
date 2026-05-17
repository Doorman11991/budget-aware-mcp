// Fuzzy Discovery Layer
// Symbol name search, file path search, type signature search.
// All run against indexed graph metadata — no embeddings.

export class FuzzyFinder {
  constructor(private db: any) {}

  /**
   * Fuzzy symbol search: case-insensitive, camelCase/snake_case splitting.
   */
  async findSymbol(query: string, maxResults: number): Promise<any[]> {
    const dbInst = this.db.instance;

    // Split query into tokens for broader matching
    const tokens = this.splitIdentifier(query.trim());
    const lowerQuery = query.toLowerCase();

    // Exact name match (highest priority)
    let results = dbInst.prepare(
      "SELECT name, fqn, kind, file_path, start_line, end_line, signature FROM symbols WHERE LOWER(name) = ? ORDER BY name LIMIT ?"
    ).all(lowerQuery, maxResults) as any[];

    if (results.length >= maxResults) return results;

    // Prefix match
    const prefixResults = dbInst.prepare(
      "SELECT name, fqn, kind, file_path, start_line, end_line, signature FROM symbols WHERE LOWER(name) LIKE ? ORDER BY name LIMIT ?"
    ).all(`${lowerQuery}%`, maxResults - results.length) as any[];

    results = [...results, ...prefixResults];
    if (results.length >= maxResults) return this.dedupe(results, maxResults);

    // Contains match
    const containsResults = dbInst.prepare(
      "SELECT name, fqn, kind, file_path, start_line, end_line, signature FROM symbols WHERE LOWER(name) LIKE ? OR LOWER(fqn) LIKE ? ORDER BY name LIMIT ?"
    ).all(`%${lowerQuery}%`, `%${lowerQuery}%`, maxResults - results.length) as any[];

    results = [...results, ...containsResults];
    if (results.length >= maxResults) return this.dedupe(results, maxResults);

    // Token-based match (split camelCase query, match any token)
    if (tokens.length > 1) {
      for (const token of tokens) {
        if (token.length < 2) continue;
        const tokenResults = dbInst.prepare(
          "SELECT name, fqn, kind, file_path, start_line, end_line, signature FROM symbols WHERE LOWER(name) LIKE ? LIMIT ?"
        ).all(`%${token.toLowerCase()}%`, 5) as any[];
        results = [...results, ...tokenResults];
      }
    }

    return this.dedupe(results, maxResults);
  }

  /**
   * File path search: match against directory structure.
   */
  async findByPath(pathPattern: string, maxResults: number): Promise<any[]> {
    const dbInst = this.db.instance;
    const pattern = pathPattern.replace(/\*/g, "%");

    const results = dbInst.prepare(
      "SELECT path, language, byte_size, line_count, symbol_count FROM indexed_files WHERE path LIKE ? ORDER BY path LIMIT ?"
    ).all(`%${pattern}%`, maxResults) as any[];

    return results;
  }

  /**
   * Type signature search: find functions with matching param/return types.
   */
  async findBySignature(paramTypes: string[], returnType: string): Promise<any[]> {
    const dbInst = this.db.instance;

    // Build a LIKE pattern from param types
    let results: any[] = [];

    for (const paramType of paramTypes) {
      const matches = dbInst.prepare(
        "SELECT name, fqn, kind, file_path, signature FROM symbols WHERE LOWER(signature) LIKE ? AND kind IN ('function', 'method') LIMIT 20"
      ).all(`%${paramType.toLowerCase()}%`) as any[];
      results = [...results, ...matches];
    }

    // If return type specified, filter further
    if (returnType) {
      results = results.filter(r =>
        r.signature.toLowerCase().includes(returnType.toLowerCase())
      );
    }

    return this.dedupe(results, 20);
  }

  /**
   * Split a camelCase or snake_case identifier into tokens.
   */
  private splitIdentifier(name: string): string[] {
    // Split on underscore, dash, dot
    let parts = name.split(/[_\-./\\]/);

    // Split camelCase
    const allParts: string[] = [];
    for (const part of parts) {
      const camelParts = part.replace(/([a-z])([A-Z])/g, "$1 $2").split(" ");
      allParts.push(...camelParts);
    }

    return allParts.filter(p => p.length > 0).map(p => p.toLowerCase());
  }

  private dedupe(results: any[], max: number): any[] {
    const seen = new Set<string>();
    const unique: any[] = [];
    for (const r of results) {
      const key = r.fqn || r.path;
      if (!seen.has(key)) {
        seen.add(key);
        unique.push(r);
        if (unique.length >= max) break;
      }
    }
    return unique;
  }
}
