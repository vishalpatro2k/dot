/**
 * Simple Memory Store
 * 
 * Stores conversation history and key facts for context.
 */

import Database from "better-sqlite3";
import * as fs from "fs";
import * as path from "path";

const DB_PATH = path.join(process.cwd(), "data", "memory.db");

export interface MemoryEntry {
  id: number;
  type: "fact" | "preference" | "person" | "project" | "conversation";
  key: string;
  content: string;
  createdAt: Date;
  lastUsed: Date;
  useCount: number;
}

export class MemoryStore {
  private db: Database.Database | null = null;

  init() {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    this.db = new Database(DB_PATH);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        key TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_used DATETIME DEFAULT CURRENT_TIMESTAMP,
        use_count INTEGER DEFAULT 1,
        UNIQUE(type, key)
      );

      CREATE TABLE IF NOT EXISTS conversations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        model TEXT,
        cost REAL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS kv_store (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type);
      CREATE INDEX IF NOT EXISTS idx_conversations_date ON conversations(created_at);
    `);

    console.log("✓ Memory initialized");
  }

  /**
   * Store a fact or piece of information
   */
  remember(type: MemoryEntry["type"], key: string, content: string) {
    if (!this.db) return;

    this.db.prepare(`
      INSERT INTO memories (type, key, content)
      VALUES (?, ?, ?)
      ON CONFLICT(type, key) DO UPDATE SET
        content = excluded.content,
        last_used = CURRENT_TIMESTAMP,
        use_count = use_count + 1
    `).run(type, key, content);
  }

  /**
   * Retrieve memories by type
   */
  recall(type?: MemoryEntry["type"], limit = 10): MemoryEntry[] {
    if (!this.db) return [];

    const query = type
      ? this.db.prepare(`
          SELECT * FROM memories 
          WHERE type = ?
          ORDER BY last_used DESC
          LIMIT ?
        `).all(type, limit)
      : this.db.prepare(`
          SELECT * FROM memories 
          ORDER BY last_used DESC
          LIMIT ?
        `).all(limit);

    return (query as any[]).map((row) => ({
      id: row.id,
      type: row.type,
      key: row.key,
      content: row.content,
      createdAt: new Date(row.created_at),
      lastUsed: new Date(row.last_used),
      useCount: row.use_count,
    }));
  }

  /**
   * Search memories by keyword
   */
  search(query: string, limit = 5): MemoryEntry[] {
    if (!this.db) return [];

    const results = this.db.prepare(`
      SELECT * FROM memories
      WHERE key LIKE ? OR content LIKE ?
      ORDER BY last_used DESC
      LIMIT ?
    `).all(`%${query}%`, `%${query}%`, limit);

    return (results as any[]).map((row) => ({
      id: row.id,
      type: row.type,
      key: row.key,
      content: row.content,
      createdAt: new Date(row.created_at),
      lastUsed: new Date(row.last_used),
      useCount: row.use_count,
    }));
  }

  /**
   * Log a conversation turn
   */
  logConversation(role: "user" | "assistant", content: string, model?: string, cost?: number) {
    if (!this.db) return;

    this.db.prepare(`
      INSERT INTO conversations (role, content, model, cost)
      VALUES (?, ?, ?, ?)
    `).run(role, content, model || null, cost || null);
  }

  /**
   * Get recent conversation history
   */
  getRecentConversations(limit = 20): { role: string; content: string; createdAt: Date }[] {
    if (!this.db) return [];

    const results = this.db.prepare(`
      SELECT role, content, created_at 
      FROM conversations
      ORDER BY id DESC
      LIMIT ?
    `).all(limit);

    return (results as any[]).reverse().map((row) => ({
      role: row.role,
      content: row.content,
      createdAt: new Date(row.created_at),
    }));
  }

  /**
   * Get usage stats
   */
  getStats() {
    if (!this.db) return { memories: 0, conversations: 0, totalCost: 0 };

    const memCount = (this.db.prepare("SELECT COUNT(*) as count FROM memories").get() as any).count;
    const convCount = (this.db.prepare("SELECT COUNT(*) as count FROM conversations").get() as any).count;
    const totalCost = (this.db.prepare("SELECT SUM(cost) as total FROM conversations").get() as any).total || 0;

    return {
      memories: memCount,
      conversations: convCount,
      totalCost: totalCost,
    };
  }

  /**
   * Save arbitrary JSON value (for wellness stats, learning patterns, etc.)
   */
  saveKV(key: string, value: unknown): void {
    if (!this.db) return;
    this.db.prepare(`
      INSERT INTO kv_store (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
    `).run(key, JSON.stringify(value));
  }

  /**
   * Retrieve a previously saved JSON value. Returns null if not found.
   */
  getKV<T = unknown>(key: string): T | null {
    if (!this.db) return null;
    const row = this.db.prepare("SELECT value FROM kv_store WHERE key = ?").get(key) as { value: string } | undefined;
    if (!row) return null;
    try { return JSON.parse(row.value) as T; } catch { return null; }
  }

  /**
   * Get context string for the agent
   */
  getContextString(): string {
    const recent = this.recall(undefined, 5);
    if (recent.length === 0) return "";

    return recent.map((m) => `• [${m.type}] ${m.key}: ${m.content}`).join("\n");
  }
}

export const memory = new MemoryStore();
