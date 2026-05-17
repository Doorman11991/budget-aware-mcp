// Session Tracking — per-session token accounting.
// Every query records tokens used/saved so agents see cumulative value.

export class SessionTracker {
  constructor(private db: any) {}

  /**
   * Record a query execution in session stats.
   */
  recordQuery(sessionId: string, tokensReturned: number, queryMs: number): void {
    const dbInst = this.db.instance;

    // Upsert session
    const existing = dbInst.prepare(
      "SELECT * FROM sessions WHERE session_id = ?"
    ).get(sessionId) as any;

    if (existing) {
      dbInst.prepare(`
        UPDATE sessions SET
          total_queries = total_queries + 1,
          total_tokens_returned = total_tokens_returned + ?,
          last_query_at = datetime('now')
        WHERE session_id = ?
      `).run(Math.round(tokensReturned), sessionId);
    } else {
      dbInst.prepare(`
        INSERT INTO sessions (session_id, total_queries, total_tokens_returned, total_tokens_saved, total_files_touched, repos_queried, started_at, last_query_at)
        VALUES (?, 1, ?, 0, 0, '[]', datetime('now'), datetime('now'))
      `).run(sessionId, Math.round(tokensReturned));
    }
  }

  /**
   * Get session statistics.
   */
  getStats(sessionId: string): any {
    const dbInst = this.db.instance;

    const session = dbInst.prepare(
      "SELECT * FROM sessions WHERE session_id = ?"
    ).get(sessionId) as any;

    if (!session) {
      return {
        session_id: sessionId,
        total_queries: 0,
        total_tokens_returned: 0,
        total_tokens_saved: 0,
        message: "No queries recorded for this session yet",
      };
    }

    // Get repo-level stats
    const repoStats = dbInst.prepare(`
      SELECT
        (SELECT COUNT(*) FROM repositories) as repos_indexed,
        (SELECT COUNT(*) FROM symbols) as total_symbols,
        (SELECT COUNT(*) FROM edges) as total_edges,
        (SELECT SUM(total_loc) FROM repositories) as total_loc
    `).get() as any;

    const coverage = repoStats.total_symbols > 0
      ? Math.round((session.total_tokens_returned / (repoStats.total_loc || 1)) * 100 * 100) / 100
      : 0;

    return {
      session_id: session.session_id,
      total_queries: session.total_queries,
      total_tokens_returned: session.total_tokens_returned,
      total_tokens_saved: session.total_tokens_saved,
      started_at: session.started_at,
      last_query_at: session.last_query_at,
      repo_context: {
        repos_indexed: repoStats.repos_indexed,
        total_symbols: repoStats.total_symbols,
        total_edges: repoStats.total_edges,
        total_loc: repoStats.total_loc || 0,
        coverage_percent: coverage,
      },
    };
  }
}
