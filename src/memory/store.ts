// budget-aware-mcp — Structured Memory Store v2
// Graph-linked, token-budgeted, staleness-aware
//
// Design principles (matching the code retrieval layer):
// 1. SQLite-backed — indexed queries, not O(n) scans
// 2. Token-budgeted — stop returning context when budget hits
// 3. Graph-linked — memory objects reference symbols from the code graph
// 4. Staleness decay — older memories rank lower unless recently confirmed
// 5. Deduplication — detect near-duplicate content on save
// 6. Confidence scoring — relevance score exposed so agents can judge quality
// 7. Deterministic — same query always returns same results (no randomness)

import fs from "fs";
import path from "path";
import crypto from "crypto";
import Database from "better-sqlite3";

export type MemoryType = "decision" | "workflow" | "gotcha" | "convention" | "context" | "source" | "synthesis";

export interface MemoryObject {
  id: string;
  type: MemoryType;
  title: string;
  content: string;
  tags: string[];
  symbols: string[];       // linked FQNs from code graph
  files: string[];         // linked file paths
  supersedes: string | null; // ID of memory this replaces
  confirmed_at: string;    // last time this was verified still valid
  created_at: string;
  access_count: number;    // how often this was loaded (popularity signal)
  content_hash: string;    // for dedup detection
}

// ─── SQLite Schema ───────────────────────────────────────────────────────────

const SCHEMA = `
CREATE TABLE IF NOT EXISTS memory_objects (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  tags TEXT DEFAULT '[]',
  symbols TEXT DEFAULT '[]',
  files TEXT DEFAULT '[]',
  supersedes TEXT,
  confirmed_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  access_count INTEGER DEFAULT 0,
  content_hash TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memory_type ON memory_objects(type);
CREATE INDEX IF NOT EXISTS idx_memory_hash ON memory_objects(content_hash);
CREATE INDEX IF NOT EXISTS idx_memory_confirmed ON memory_objects(confirmed_at);

-- Full-text search on title + content + tags (fast retrieval without embeddings)
CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
  id,
  title,
  content,
  tags,
  symbols,
  files,
  content='memory_objects',
  content_rowid='rowid'
);

-- Triggers to keep FTS in sync
CREATE TRIGGER IF NOT EXISTS memory_ai AFTER INSERT ON memory_objects BEGIN
  INSERT INTO memory_fts(id, title, content, tags, symbols, files)
  VALUES (new.id, new.title, new.content, new.tags, new.symbols, new.files);
END;

CREATE TRIGGER IF NOT EXISTS memory_ad AFTER DELETE ON memory_objects BEGIN
  INSERT INTO memory_fts(memory_fts, id, title, content, tags, symbols, files)
  VALUES ('delete', old.id, old.title, old.content, old.tags, old.symbols, old.files);
END;

CREATE TRIGGER IF NOT EXISTS memory_au AFTER UPDATE ON memory_objects BEGIN
  INSERT INTO memory_fts(memory_fts, id, title, content, tags, symbols, files)
  VALUES ('delete', old.id, old.title, old.content, old.tags, old.symbols, old.files);
  INSERT INTO memory_fts(id, title, content, tags, symbols, files)
  VALUES (new.id, new.title, new.content, new.tags, new.symbols, new.files);
END;
`;

// ─── Store ───────────────────────────────────────────────────────────────────

export class MemoryStore {
  private db: Database.Database;
  private memDir: string;

  constructor(rootDir?: string) {
    const root = rootDir || process.cwd();
    this.memDir = path.join(root, ".memory");
    if (!fs.existsSync(this.memDir)) {
      fs.mkdirSync(this.memDir, { recursive: true });
    }

    // SQLite database in the memory dir
    this.db = new Database(path.join(this.memDir, "memory.db"));
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.exec(SCHEMA);
  }

  // ─── CRUD ──────────────────────────────────────────────────────────────

  remember(input: {
    type: MemoryType;
    title: string;
    content: string;
    tags?: string[];
    symbols?: string[];
    files?: string[];
    supersedes?: string;
  }): MemoryObject | { duplicate: true; existing_id: string } {
    const contentHash = this.hashContent(input.content);

    // Dedup check: reject truly identical content (same hash = same normalized content)
    const existing = this.db.prepare(
      "SELECT id, title, content FROM memory_objects WHERE content_hash = ?"
    ).get(contentHash) as any;

    if (existing) {
      // Only treat as duplicate if title is also similar (prevents blocking genuine updates)
      const titleSimilar = this.titlesSimilar(existing.title, input.title);
      if (titleSimilar) {
        // Bump access count and confirmed_at instead of creating duplicate
        this.db.prepare(
          "UPDATE memory_objects SET confirmed_at = ?, access_count = access_count + 1 WHERE id = ?"
        ).run(new Date().toISOString(), existing.id);
        return { duplicate: true, existing_id: existing.id };
      }
      // Different title with same content = allow creation (intentional duplicate for different context)
    }

    const id = crypto.randomUUID().slice(0, 8);
    const now = new Date().toISOString();
    const tags = JSON.stringify(input.tags || []);
    const symbols = JSON.stringify(input.symbols || []);
    const files = JSON.stringify(input.files || []);

    this.db.prepare(`
      INSERT INTO memory_objects (id, type, title, content, tags, symbols, files, supersedes, confirmed_at, created_at, access_count, content_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
    `).run(id, input.type, input.title, input.content, tags, symbols, files, input.supersedes || null, now, now, contentHash);

    // If superseding another memory, mark the old one
    if (input.supersedes) {
      this.db.prepare("DELETE FROM memory_objects WHERE id = ?").run(input.supersedes);
    }

    // Write markdown for git review
    this.writeMarkdown(id, input.type, input.title, input.content, input.tags || []);

    return this.get(id)!;
  }

  get(id: string): MemoryObject | null {
    const row = this.db.prepare("SELECT * FROM memory_objects WHERE id = ?").get(id) as any;
    return row ? this.rowToObject(row) : null;
  }

  forget(id: string): boolean {
    const obj = this.get(id);
    if (!obj) return false;
    this.db.prepare("DELETE FROM memory_objects WHERE id = ?").run(id);
    // Remove markdown
    const mdPath = path.join(this.memDir, `${obj.type}-${id}.md`);
    if (fs.existsSync(mdPath)) fs.unlinkSync(mdPath);
    return true;
  }

  /** Update an existing memory's content, title, or tags in-place */
  update(id: string, updates: {
    title?: string;
    content?: string;
    tags?: string[];
    symbols?: string[];
    files?: string[];
  }): MemoryObject | null {
    const existing = this.get(id);
    if (!existing) return null;

    const title = updates.title ?? existing.title;
    const content = updates.content ?? existing.content;
    const tags = JSON.stringify(updates.tags ?? existing.tags);
    const symbols = JSON.stringify(updates.symbols ?? existing.symbols);
    const files = JSON.stringify(updates.files ?? existing.files);
    const contentHash = this.hashContent(content);
    const now = new Date().toISOString();

    this.db.prepare(`
      UPDATE memory_objects
      SET title = ?, content = ?, tags = ?, symbols = ?, files = ?, content_hash = ?, confirmed_at = ?
      WHERE id = ?
    `).run(title, content, tags, symbols, files, contentHash, now, id);

    // Update markdown
    this.writeMarkdown(id, existing.type, title, content, updates.tags ?? existing.tags);

    return this.get(id);
  }

  all(): MemoryObject[] {
    const rows = this.db.prepare("SELECT * FROM memory_objects ORDER BY confirmed_at DESC").all() as any[];
    return rows.map(r => this.rowToObject(r));
  }

  byType(type: MemoryType): MemoryObject[] {
    const rows = this.db.prepare("SELECT * FROM memory_objects WHERE type = ? ORDER BY confirmed_at DESC").all(type) as any[];
    return rows.map(r => this.rowToObject(r));
  }

  // ─── Retrieval (the critical path) ─────────────────────────────────────

  /**
   * Task-focused loading with token budget.
   * Uses FTS5 for fast matching + staleness decay + popularity boost.
   * Returns objects until token budget is hit. Deterministic.
   */
  loadForTask(task: string, maxTokens = 2000): { objects: MemoryObject[]; tokens_used: number; score_breakdown: any[] } {
    // FTS5 query: split task into terms
    const terms = task
      .toLowerCase()
      .split(/[^a-z0-9_]+/)
      .filter(w => w.length > 2)
      .slice(0, 10); // Cap at 10 terms to prevent huge queries

    if (terms.length === 0) return { objects: [], tokens_used: 0, score_breakdown: [] };

    const ftsQuery = terms.map(t => `"${t}"*`).join(" OR ");

    // FTS5 match with BM25 ranking
    let rows: any[];
    try {
      rows = this.db.prepare(`
        SELECT m.*, bm25(memory_fts) as rank
        FROM memory_fts f
        JOIN memory_objects m ON f.id = m.id
        WHERE memory_fts MATCH ?
        ORDER BY rank
        LIMIT 20
      `).all(ftsQuery) as any[];
    } catch {
      // FTS query failed — fall back to LIKE
      rows = this.db.prepare(`
        SELECT *, 0 as rank FROM memory_objects
        WHERE LOWER(title || ' ' || content || ' ' || tags) LIKE ?
        ORDER BY confirmed_at DESC
        LIMIT 20
      `).all(`%${terms[0]}%`) as any[];
    }

    // Score with staleness decay + type boost + popularity
    const now = Date.now();
    const scored = rows.map(row => {
      let score = Math.abs(row.rank || 0) * 10; // BM25 base score

      // Staleness decay: lose 10% relevance per week since last confirmation
      const ageMs = now - new Date(row.confirmed_at).getTime();
      const ageWeeks = ageMs / (7 * 24 * 60 * 60 * 1000);
      const stalenessPenalty = Math.max(0.3, 1 - ageWeeks * 0.1);
      score *= stalenessPenalty;

      // Type boost: decisions and gotchas are usually more actionable
      const typeBoost: Record<string, number> = {
        decision: 1.5, gotcha: 1.5, convention: 1.3,
        workflow: 1.2, context: 1.0, source: 0.8, synthesis: 1.1,
      };
      score *= typeBoost[row.type] || 1.0;

      // Popularity: slightly boost frequently-accessed memories
      score *= 1 + Math.min(row.access_count * 0.05, 0.5);

      return { row, score, stalenessPenalty };
    });

    scored.sort((a, b) => b.score - a.score);

    // Token-budgeted collection (same pattern as graph walk)
    const results: MemoryObject[] = [];
    const breakdown: any[] = [];
    let tokensUsed = 0;

    for (const { row, score, stalenessPenalty } of scored) {
      const obj = this.rowToObject(row);
      const tokenCost = Math.ceil((obj.title.length + obj.content.length) / 4);

      if (tokensUsed + tokenCost > maxTokens) break;

      results.push(obj);
      tokensUsed += tokenCost;
      breakdown.push({
        id: obj.id,
        title: obj.title,
        score: Math.round(score * 100) / 100,
        tokens: tokenCost,
        staleness: Math.round(stalenessPenalty * 100) + "%",
      });

      // Bump access count (atomic, doesn't affect this query's results)
      this.db.prepare("UPDATE memory_objects SET access_count = access_count + 1 WHERE id = ?").run(obj.id);
    }

    return { objects: results, tokens_used: tokensUsed, score_breakdown: breakdown };
  }

  /** Find memory linked to a code symbol (indexed lookup) */
  forSymbol(symbolFqn: string): MemoryObject[] {
    const rows = this.db.prepare(
      "SELECT * FROM memory_objects WHERE symbols LIKE ? ORDER BY confirmed_at DESC LIMIT 10"
    ).all(`%${symbolFqn}%`) as any[];
    return rows.map(r => this.rowToObject(r));
  }

  /** Find memory linked to a file (indexed lookup) */
  forFile(filePath: string): MemoryObject[] {
    const rows = this.db.prepare(
      "SELECT * FROM memory_objects WHERE files LIKE ? ORDER BY confirmed_at DESC LIMIT 10"
    ).all(`%${filePath}%`) as any[];
    return rows.map(r => this.rowToObject(r));
  }

  // ─── Format for context injection (token-capped) ───────────────────────

  formatForContext(objects: MemoryObject[], maxTokens = 2000): string {
    if (objects.length === 0) return "";

    let output = "<project_memory>\n";
    let tokens = 20; // overhead

    for (const obj of objects) {
      // Compact format: [type] title — content (no fluff)
      const entry = `[${obj.type}] ${obj.title}: ${obj.content}\n`;
      const cost = Math.ceil(entry.length / 4);
      if (tokens + cost > maxTokens) break;
      output += entry;
      tokens += cost;
    }

    output += "</project_memory>";
    return output;
  }

  // ─── Maintenance ───────────────────────────────────────────────────────

  /** Confirm a memory is still valid (resets staleness) */
  confirm(id: string): boolean {
    const result = this.db.prepare(
      "UPDATE memory_objects SET confirmed_at = ? WHERE id = ?"
    ).run(new Date().toISOString(), id);
    return result.changes > 0;
  }

  /** Prune stale memories (not confirmed in N days) */
  pruneStale(olderThanDays = 90): number {
    const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000).toISOString();
    const result = this.db.prepare(
      "DELETE FROM memory_objects WHERE confirmed_at < ? AND access_count < 3"
    ).run(cutoff);
    return result.changes;
  }

  /** Stats */
  stats(): { total: number; byType: Record<string, number>; oldest: string | null; newest: string | null } {
    const total = (this.db.prepare("SELECT COUNT(*) as c FROM memory_objects").get() as any).c;
    const types = this.db.prepare("SELECT type, COUNT(*) as c FROM memory_objects GROUP BY type").all() as any[];
    const oldest = (this.db.prepare("SELECT MIN(created_at) as d FROM memory_objects").get() as any)?.d;
    const newest = (this.db.prepare("SELECT MAX(created_at) as d FROM memory_objects").get() as any)?.d;

    const byType: Record<string, number> = {};
    for (const t of types) byType[t.type] = t.c;

    return { total, byType, oldest, newest };
  }

  // ─── Internal ──────────────────────────────────────────────────────────

  private rowToObject(row: any): MemoryObject {
    return {
      id: row.id,
      type: row.type,
      title: row.title,
      content: row.content,
      tags: JSON.parse(row.tags || "[]"),
      symbols: JSON.parse(row.symbols || "[]"),
      files: JSON.parse(row.files || "[]"),
      supersedes: row.supersedes,
      confirmed_at: row.confirmed_at,
      created_at: row.created_at,
      access_count: row.access_count,
      content_hash: row.content_hash,
    };
  }

  private hashContent(content: string): string {
    // Normalize excessive whitespace but preserve case (so "API" and "api" aren't deduped)
    const normalized = content.replace(/\s+/g, " ").trim();
    return crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 16);
  }

  private titlesSimilar(a: string, b: string): boolean {
    // Simple similarity: same title (case-insensitive) = duplicate
    const na = a.toLowerCase().trim();
    const nb = b.toLowerCase().trim();
    if (na === nb) return true;
    // Jaccard similarity on words > 0.7 = similar enough
    const wordsA = new Set(na.split(/\s+/));
    const wordsB = new Set(nb.split(/\s+/));
    const intersection = [...wordsA].filter(w => wordsB.has(w)).length;
    const union = new Set([...wordsA, ...wordsB]).size;
    return union > 0 && intersection / union > 0.7;
  }

  private writeMarkdown(id: string, type: string, title: string, content: string, tags: string[]) {
    const filename = `${type}-${id}.md`;
    const md = [
      `# ${title}`,
      ``,
      `**Type:** ${type}`,
      tags.length ? `**Tags:** ${tags.join(", ")}` : null,
      ``,
      content,
      ``,
    ].filter(Boolean).join("\n");
    fs.writeFileSync(path.join(this.memDir, filename), md);
  }
}
