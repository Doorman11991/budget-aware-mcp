// Cluster Discovery + Architecture Analysis
// Find major subsystems, hotspots, entry points, language breakdown.

export class ClusterDiscovery {
  constructor(private db: any) {}

  /**
   * Full architecture overview: clusters, hotspots, entry points, languages.
   */
  async discover(maxClusters: number): Promise<any> {
    const dbInst = this.db.instance;

    // Get all symbols with their edge counts
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
      return { clusters: [], hotspots: [], entry_points: [], languages: [], total_symbols: 0 };
    }

    // ─── Clusters (by directory) ─────────────────────────────────────
    const dirGroups = new Map<string, any[]>();
    for (const sym of symbols) {
      const dir = sym.file_path.split(/[/\\]/).slice(0, -1).join("/") || "(root)";
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
          .map((s: any) => ({ name: s.name, fqn: s.fqn, kind: s.kind, connectivity: s.in_degree + s.out_degree })),
        primary_kinds: this.countKinds(syms),
      }))
      .sort((a, b) => b.total_connectivity - a.total_connectivity)
      .slice(0, maxClusters);

    // ─── Hotspots (most-connected symbols) ───────────────────────────
    const hotspots = symbols
      .slice(0, 10)
      .map((s: any) => ({
        name: s.name,
        fqn: s.fqn,
        kind: s.kind,
        file: s.file_path,
        fan_in: s.in_degree,
        fan_out: s.out_degree,
        total: s.in_degree + s.out_degree,
      }));

    // ─── Entry points (high out-degree, low in-degree = likely entry) ─
    const entryPoints = symbols
      .filter((s: any) => s.out_degree > 0 && s.in_degree <= 1)
      .sort((a: any, b: any) => b.out_degree - a.out_degree)
      .slice(0, 10)
      .map((s: any) => ({
        name: s.name,
        fqn: s.fqn,
        kind: s.kind,
        file: s.file_path,
        calls_out: s.out_degree,
      }));

    // ─── Language breakdown ──────────────────────────────────────────
    const languages = dbInst.prepare(
      "SELECT language, COUNT(*) as files, SUM(line_count) as lines FROM indexed_files WHERE language != '' GROUP BY language ORDER BY files DESC"
    ).all() as any[];

    // ─── Summary stats ───────────────────────────────────────────────
    const totalSymbols = dbInst.prepare("SELECT COUNT(*) as c FROM symbols").get() as any;
    const totalEdges = dbInst.prepare("SELECT COUNT(*) as c FROM edges").get() as any;
    const totalFiles = dbInst.prepare("SELECT COUNT(*) as c FROM indexed_files").get() as any;

    return {
      clusters,
      hotspots,
      entry_points: entryPoints,
      languages,
      summary: {
        total_symbols: totalSymbols?.c || 0,
        total_edges: totalEdges?.c || 0,
        total_files: totalFiles?.c || 0,
        clusters_shown: clusters.length,
      },
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
