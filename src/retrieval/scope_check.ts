// Scope Check — feasibility assessment without LLM.
// Given a task description, checks if the symbols mentioned exist in the graph.

export class ScopeChecker {
  constructor(private db: any) {}

  /**
   * Check if a task is feasible given the indexed codebase.
   * Pure heuristic: extracts potential symbol names from the task description
   * and checks which exist in the graph.
   */
  async check(taskDescription: string, availableSymbols: string[]): Promise<any> {
    const dbInst = this.db.instance;

    // Extract potential identifiers from the task description
    const potentialSymbols = this.extractIdentifiers(taskDescription);

    const found: string[] = [];
    const missing: string[] = [];

    for (const sym of potentialSymbols) {
      const exists = dbInst.prepare(
        "SELECT 1 FROM symbols WHERE LOWER(name) = LOWER(?) OR LOWER(fqn) LIKE ? LIMIT 1"
      ).get(sym.toLowerCase(), `%${sym.toLowerCase()}%`);

      if (exists) {
        found.push(sym);
      } else {
        missing.push(sym);
      }
    }

    // Also check available symbols
    const availableInGraph: string[] = [];
    for (const sym of availableSymbols) {
      const exists = dbInst.prepare(
        "SELECT 1 FROM symbols WHERE fqn = ? OR name = ? LIMIT 1"
      ).get(sym, sym);
      if (exists) availableInGraph.push(sym);
    }

    // Determine feasibility
    const totalMentioned = potentialSymbols.length;
    const foundRatio = totalMentioned > 0 ? found.length / totalMentioned : 1.0;

    let feasibility: "full" | "partial" | "unknown";
    let confidence: number;

    if (foundRatio >= 0.8 || found.length >= 3) {
      feasibility = "full";
      confidence = Math.min(0.95, 0.5 + foundRatio * 0.5);
    } else if (foundRatio >= 0.3 || found.length >= 1) {
      feasibility = "partial";
      confidence = 0.3 + foundRatio * 0.4;
    } else {
      feasibility = "unknown";
      confidence = Math.max(0.1, foundRatio * 0.3);
    }

    // Get repo stats for context
    const repoCount = dbInst.prepare("SELECT COUNT(*) as cnt FROM repositories").get() as any;
    const symbolCount = dbInst.prepare("SELECT COUNT(*) as cnt FROM symbols").get() as any;

    return {
      feasibility,
      confidence: Math.round(confidence * 100) / 100,
      found_symbols: found,
      missing_symbols: missing,
      available_in_graph: availableInGraph,
      context: {
        repos_indexed: repoCount?.cnt || 0,
        total_symbols: symbolCount?.cnt || 0,
        symbols_mentioned_in_task: totalMentioned,
        symbols_found: found.length,
      },
    };
  }

  /**
   * Extract potential identifier names from a natural language description.
   * Looks for camelCase, PascalCase, snake_case, and quoted strings.
   */
  private extractIdentifiers(text: string): string[] {
    const identifiers = new Set<string>();

    // Quoted strings
    const quoted = text.match(/[`'"]([\w.]+)[`'"]/g);
    if (quoted) {
      for (const q of quoted) {
        identifiers.add(q.replace(/[`'"]/g, ""));
      }
    }

    // CamelCase / PascalCase words (2+ uppercase letters or starts with uppercase)
    const camel = text.match(/\b[A-Z][a-zA-Z0-9]{2,}\b/g);
    if (camel) {
      for (const c of camel) identifiers.add(c);
    }

    // snake_case identifiers
    const snake = text.match(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g);
    if (snake) {
      for (const s of snake) identifiers.add(s);
    }

    // Dot-separated paths (like module.ClassName)
    const dotted = text.match(/\b[\w]+(?:\.[\w]+)+\b/g);
    if (dotted) {
      for (const d of dotted) identifiers.add(d);
    }

    return [...identifiers];
  }
}
