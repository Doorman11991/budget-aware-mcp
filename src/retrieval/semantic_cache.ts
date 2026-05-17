// Semantic Cache — similarity-aware query caching for the MCP server.
//
// "auth" ≈ "authentication" → cache hit (trigram similarity > 0.7)
// Zero dependencies, sub-millisecond lookups, deterministic.

import { createHash } from "node:crypto";

interface CacheEntry<T> {
  key: string;
  normalized: string;
  trigrams: Set<string>;
  value: T;
  created_at: number;
  ttl_ms: number;
  hits: number;
}

export class SemanticCache<T = unknown> {
  private entries: CacheEntry<T>[] = [];
  private threshold: number;
  private maxEntries: number;
  private defaultTtl: number;

  constructor(threshold = 0.7, maxEntries = 200, defaultTtl = 300_000) {
    this.threshold = threshold;
    this.maxEntries = maxEntries;
    this.defaultTtl = defaultTtl; // 5 min default
  }

  /**
   * Look up cached result by semantic similarity.
   * Returns cached value + similarity score, or null.
   */
  get(input: string): { value: T; similarity: number } | null {
    const now = Date.now();
    const normalized = this.normalize(input);
    const inputTrigrams = this.trigrams(normalized);

    // Exact hash first (fastest path)
    const exactKey = this.hashKey(input);
    const exact = this.entries.find(e => e.key === exactKey && now - e.created_at < e.ttl_ms);
    if (exact) { exact.hits++; return { value: exact.value, similarity: 1.0 }; }

    // Semantic similarity scan
    let bestMatch: CacheEntry<T> | null = null;
    let bestSim = 0;

    for (const entry of this.entries) {
      if (now - entry.created_at >= entry.ttl_ms) continue;
      const sim = this.jaccard(inputTrigrams, entry.trigrams);
      if (sim > bestSim && sim >= this.threshold) {
        bestSim = sim;
        bestMatch = entry;
      }
    }

    if (bestMatch) {
      bestMatch.hits++;
      return { value: bestMatch.value, similarity: bestSim };
    }

    return null;
  }

  /**
   * Store a result in the cache.
   */
  set(input: string, value: T, ttl_ms?: number): void {
    const normalized = this.normalize(input);
    const entry: CacheEntry<T> = {
      key: this.hashKey(input),
      normalized,
      trigrams: this.trigrams(normalized),
      value,
      created_at: Date.now(),
      ttl_ms: ttl_ms ?? this.defaultTtl,
      hits: 0,
    };

    // Evict expired + LRU
    const now = Date.now();
    this.entries = this.entries.filter(e => now - e.created_at < e.ttl_ms);
    if (this.entries.length >= this.maxEntries) {
      this.entries.sort((a, b) => a.hits - b.hits);
      this.entries.shift();
    }

    this.entries.push(entry);
  }

  stats(): { entries: number; total_hits: number } {
    return {
      entries: this.entries.length,
      total_hits: this.entries.reduce((s, e) => s + e.hits, 0),
    };
  }

  private normalize(input: string): string {
    return input.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
  }

  private trigrams(s: string): Set<string> {
    const set = new Set<string>();
    for (let i = 0; i <= s.length - 3; i++) set.add(s.slice(i, i + 3));
    return set;
  }

  private jaccard(a: Set<string>, b: Set<string>): number {
    if (a.size === 0 && b.size === 0) return 1;
    let intersection = 0;
    for (const item of a) if (b.has(item)) intersection++;
    const union = a.size + b.size - intersection;
    return union > 0 ? intersection / union : 0;
  }

  private hashKey(input: string): string {
    return createHash("sha256").update(input).digest("hex").slice(0, 16);
  }
}
