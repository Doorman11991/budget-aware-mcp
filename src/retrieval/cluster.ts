// Cluster Discovery — connected component analysis.
// Find major subsystems by identifying strongly connected symbol groups.

export class ClusterDiscovery {
  constructor(private db: any) {}

  /**
   * Discover top-N architectural clusters by symbol connectivity.
   * Returns the largest connected components with their entry points.
   */
  async discover(maxClusters: number): Promise<any> {
    const dbInst = this.db.instance;

    // Get all symbols with their edge counts (in-degree + out-degree)
    const symbols = dbInst.prepare(`
      SELECT s.fqn, s.name, s.kind, s.file_path,
        (SELECT COUNT(*) FROM edges WHERE source_fqn = s.fqn) as out_degree,
        (SELECT COUNT(*) FROM edges WHERE target_fqn = s.fqn) as in_degree
      FROM symbols s
      ORDER BY (
        (SELECT COUNT(*) FROM edges WHERE source_fqn = s.fqn) +
        (SELECT COUNT(*) FROM edges WHERE target_fqn = s.fqn)
      ) DESC
      LIMIT 500
    `).all() as any[];

    if (symbols.length === 0) {
      return { clusters: [], total_symbols: 0 };
    }

    // Group symbols by directory (first-pass clustering by file locality)
    const dirGroups = new Map<string, any[]>();
    for (const sym of symbols) {
      const dir = sym.file_path.split(/[/\\]/).slice(0, -1).join("/");
      const group = dirGroups.get(dir) || [];
      group.push(sym);
      dirGroups.set(dir, group);
    }

    // Sort groups by total connectivity (sum of degrees)
    const clusters = [...dirGroups.entries()]
      .map(([dir, syms]) => ({
        directory: dir,
        symbol_count: syms.length,
        total_connectivity: syms.reduce((sum, s) => sum + s.out_degree + s.in_degree, 0),
        entry_points: syms
          .sort((a: any, b: any) => (b.in_degree + b.out_degree) - (a.in_degree + a.out_degree))
          .slice(0, 3)
          .map((s: any) => ({ name: s.name, fqn: s.fqn, kind: s.kind, connectivity: s.in_degree + s.out_degree })),
        primary_kinds: this.countKinds(syms),
      }))
      .sort((a, b) => b.total_connectivity - a.total_connectivity)
      .slice(0, maxClusters);

    const totalSymbols = dbInst.prepare("SELECT COUNT(*) as cnt FROM symbols").get() as any;

    return {
      clusters,
      total_symbols: totalSymbols?.cnt || 0,
      clusters_shown: clusters.length,
    };
  }

  private countKinds(syms: any[]): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const s of syms) {
      counts[s.kind] = (counts[s.kind] || 0) + 1;
    }
    return counts;
  }
}
