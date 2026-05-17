// SQLite database layer for code-graph-mcp.
// Schema generated from code_graph_mcp.marrow via MarrowScript compiler.
import Database from "better-sqlite3";
import * as path from "path";
import * as fs from "fs";

class CodeGraphDB {
  private _db: Database.Database | null = null;

  get instance(): Database.Database {
    if (!this._db) {
      const dbPath = process.env.CODE_GRAPH_DB || path.resolve(process.cwd(), ".code-graph", "graph.db");
      const dir = path.dirname(dbPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      this._db = new Database(dbPath);
      this._db.pragma("journal_mode = WAL");
      this._db.pragma("foreign_keys = ON");
      this._db.pragma("synchronous = NORMAL");
      this._db.pragma("cache_size = -64000"); // 64MB cache
    }
    return this._db;
  }

  initialize() {
    const db = this.instance;

    db.exec(`
      CREATE TABLE IF NOT EXISTS repositories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        root_path TEXT NOT NULL,
        file_count INTEGER NOT NULL DEFAULT 0,
        symbol_count INTEGER NOT NULL DEFAULT 0,
        edge_count INTEGER NOT NULL DEFAULT 0,
        total_loc INTEGER NOT NULL DEFAULT 0,
        languages TEXT NOT NULL DEFAULT '[]',
        last_indexed_at TEXT,
        index_duration_ms INTEGER NOT NULL DEFAULT 0,
        state TEXT NOT NULL DEFAULT 'unindexed'
      );

      CREATE TABLE IF NOT EXISTS symbols (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        fqn TEXT NOT NULL,
        kind TEXT NOT NULL,
        file_path TEXT NOT NULL,
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        language TEXT NOT NULL DEFAULT '',
        signature TEXT NOT NULL DEFAULT '',
        docstring TEXT NOT NULL DEFAULT '',
        content_hash TEXT NOT NULL DEFAULT '',
        byte_size INTEGER NOT NULL DEFAULT 0,
        content_lz4 TEXT NOT NULL DEFAULT '',
        repo_id INTEGER NOT NULL,
        FOREIGN KEY (repo_id) REFERENCES repositories(id)
      );

      CREATE TABLE IF NOT EXISTS edges (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_fqn TEXT NOT NULL,
        target_fqn TEXT NOT NULL,
        kind TEXT NOT NULL,
        weight REAL NOT NULL DEFAULT 1.0,
        file_path TEXT NOT NULL DEFAULT '',
        repo_id INTEGER NOT NULL,
        FOREIGN KEY (repo_id) REFERENCES repositories(id)
      );

      CREATE TABLE IF NOT EXISTS indexed_files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        path TEXT NOT NULL,
        language TEXT NOT NULL DEFAULT '',
        byte_size INTEGER NOT NULL DEFAULT 0,
        line_count INTEGER NOT NULL DEFAULT 0,
        content_hash TEXT NOT NULL DEFAULT '',
        last_indexed_at TEXT,
        symbol_count INTEGER NOT NULL DEFAULT 0,
        repo_id INTEGER NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending',
        FOREIGN KEY (repo_id) REFERENCES repositories(id)
      );

      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        total_queries INTEGER NOT NULL DEFAULT 0,
        total_tokens_returned INTEGER NOT NULL DEFAULT 0,
        total_tokens_saved INTEGER NOT NULL DEFAULT 0,
        total_files_touched INTEGER NOT NULL DEFAULT 0,
        repos_queried TEXT NOT NULL DEFAULT '[]',
        started_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_query_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      -- Indexes for fast retrieval
      CREATE INDEX IF NOT EXISTS idx_symbols_fqn ON symbols(fqn);
      CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
      CREATE INDEX IF NOT EXISTS idx_symbols_file_path ON symbols(file_path);
      CREATE INDEX IF NOT EXISTS idx_symbols_kind ON symbols(kind);
      CREATE INDEX IF NOT EXISTS idx_symbols_repo ON symbols(repo_id);

      CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_fqn);
      CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_fqn);
      CREATE INDEX IF NOT EXISTS idx_edges_kind ON edges(kind);
      CREATE INDEX IF NOT EXISTS idx_edges_repo ON edges(repo_id);

      CREATE INDEX IF NOT EXISTS idx_files_path ON indexed_files(path);
      CREATE INDEX IF NOT EXISTS idx_files_repo ON indexed_files(repo_id);
      CREATE INDEX IF NOT EXISTS idx_files_hash ON indexed_files(content_hash);
    `);
  }

  close() {
    if (this._db) {
      this._db.close();
      this._db = null;
    }
  }
}

export const db = new CodeGraphDB();
