import { Database } from "bun:sqlite";
import { mkdirSync } from "fs";
import { dirname } from "path";

export type MemoryType = "preference" | "fact" | "learned";
export type MemorySource = "explicit" | "inferred";

export interface MemoryEntry {
  id?: number;
  type: MemoryType;
  key: string;
  value: string;
  source: MemorySource;
}

export interface AllMemories {
  preferences: MemoryEntry[];
  facts: MemoryEntry[];
  learned: MemoryEntry[];
}

const LIMITS: Record<MemoryType, number> = {
  preference: 2200,
  fact: 1375,
  learned: 1000,
};

const INJECTION_PATTERNS = [
  /ignore previous instructions/i,
  /you are now/i,
  /[\u200b-\u200f\u202a-\u202e]/,
  /curl.*\$|wget.*\$/i,
  /\.env/i,
];

function checkInjection(value: string): void {
  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(value)) {
      throw new Error(`blocked: injection pattern detected`);
    }
  }
}

export class MemoryStore {
  private db: Database;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.run("PRAGMA journal_mode=WAL");
    this.db.run(`
      CREATE TABLE IF NOT EXISTS memories (
        id      INTEGER PRIMARY KEY AUTOINCREMENT,
        type    TEXT NOT NULL CHECK(type IN ('preference', 'fact', 'learned')),
        key     TEXT NOT NULL,
        value   TEXT NOT NULL,
        source  TEXT NOT NULL CHECK(source IN ('explicit', 'inferred')),
        created DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    // transcript table for future cross-session context (not yet used by any component)
    this.db.run(`
      CREATE VIRTUAL TABLE IF NOT EXISTS transcript USING fts5(
        session_id, role, content, timestamp
      )
    `);
  }

  add(entry: MemoryEntry): void {
    checkInjection(entry.value);
    checkInjection(entry.key);
    const doAdd = this.db.transaction(() => {
      this.db.run(
        "INSERT INTO memories (type, key, value, source) VALUES (?, ?, ?, ?)",
        [entry.type, entry.key, entry.value, entry.source]
      );
      this.enforceLimit(entry.type);
    });
    doAdd();
  }

  replace(entry: { type: MemoryType; key: string; value: string }): void {
    checkInjection(entry.key);
    checkInjection(entry.value);
    const result = this.db.run(
      "UPDATE memories SET value = ?, updated = CURRENT_TIMESTAMP WHERE type = ? AND key = ?",
      [entry.value, entry.type, entry.key]
    );
    if (result.changes === 0) throw new Error(`no entry found with key "${entry.key}" of type "${entry.type}"`);
    this.enforceLimit(entry.type);
  }

  remove(entry: { type: MemoryType; key: string }): void {
    this.db.run("DELETE FROM memories WHERE type = ? AND key = ?", [entry.type, entry.key]);
  }

  getAll(): AllMemories {
    const rows = this.db.query("SELECT * FROM memories ORDER BY created ASC").all() as MemoryEntry[];
    return {
      preferences: rows.filter((r) => r.type === "preference"),
      facts: rows.filter((r) => r.type === "fact"),
      learned: rows.filter((r) => r.type === "learned"),
    };
  }

  close(): void {
    this.db.close();
  }

  private enforceLimit(type: MemoryType): void {
    const limit = LIMITS[type];
    // For preference: keep most recently added (newest first), drop oldest. For fact/learned: keep oldest, drop newest.
    const order = type === "preference" ? "DESC" : "ASC";
    const rows = this.db
      .query(`SELECT id, key, value FROM memories WHERE type = ? ORDER BY id ${order}`)
      .all(type) as { id: number; key: string; value: string }[];

    let total = 0;
    const toKeep: number[] = [];
    for (const row of rows) {
      total += row.key.length + row.value.length;
      if (total <= limit) toKeep.push(row.id);
    }
    if (toKeep.length < rows.length) {
      const toDrop = rows.filter((r) => !toKeep.includes(r.id)).map((r) => r.id);
      for (const id of toDrop) {
        this.db.run("DELETE FROM memories WHERE id = ?", [id]);
      }
    }
  }
}
