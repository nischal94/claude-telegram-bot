import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync } from "fs";
import { dirname } from "path";

export type MemoryType = "preference" | "fact" | "learned";
export type MemorySource = "explicit" | "inferred";

export const MEMORY_TYPES: ReadonlySet<string> = new Set<MemoryType>(["preference", "fact", "learned"]);
export const MAX_KEY_LENGTH = 100;
// Key plus value fits the smallest limit (learned, 1000), so one entry of
// the maximum size always fits in an empty store.
export const MAX_VALUE_LENGTH = 900;

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
  // Invisible characters: zero-width and direction marks, embeddings and
  // overrides, word joiner and invisible operators, isolates, byte order mark.
  /[\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/,
  /curl.*\$|wget.*\$/i,
  /\.env/i,
];

// A write the store refuses on purpose. Its message is safe to show the
// caller; any other error may carry SQLite or file details and is not.
export class MemoryRejected extends Error {}

function checkInjection(value: string): void {
  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(value)) {
      throw new MemoryRejected(`blocked: injection pattern detected`);
    }
  }
}

export class MemoryStore {
  private db: Database;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
    this.db = new Database(dbPath);
    // The database holds the owner's personal memory. SQLite creates it with
    // the process umask and gives new -wal and -shm files the database's
    // mode; journal files left from an earlier run keep their own mode, so
    // tighten all three.
    for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
      if (existsSync(path)) chmodSync(path, 0o600);
    }
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
    // One row per completed one-time import, such as the seed file.
    this.db.run(`
      CREATE TABLE IF NOT EXISTS imports (
        name TEXT PRIMARY KEY,
        at   DATETIME DEFAULT CURRENT_TIMESTAMP
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
    this.db.transaction(() => {
      this.insert(entry, []);
    })();
  }

  // Inserts one entry and applies the limit. The new row, and every row in
  // `protect`, must survive the limit, or the caller's transaction is rolled
  // back. Returns the new row's id.
  private insert(entry: MemoryEntry, protect: number[]): number {
    checkInjection(entry.value);
    checkInjection(entry.key);
    const result = this.db.run(
      "INSERT INTO memories (type, key, value, source) VALUES (?, ?, ?, ?)",
      [entry.type, entry.key, entry.value, entry.source]
    );
    const id = Number(result.lastInsertRowid);
    this.enforceLimit(entry.type, entry.source, [...protect, id]);
    return id;
  }

  // Sets the value and the source: a replace that does not say the user asked
  // for it makes the entry inferred, so it leaves the system prompt.
  replace(entry: { type: MemoryType; key: string; value: string; source: MemorySource }): void {
    checkInjection(entry.key);
    checkInjection(entry.value);
    this.db.transaction(() => {
      const ids = (this.db
        .query("SELECT id FROM memories WHERE type = ? AND key = ?")
        .all(entry.type, entry.key) as { id: number }[]).map((r) => r.id);
      if (ids.length === 0) throw new MemoryRejected(`no entry found with key "${entry.key}" of type "${entry.type}"`);
      this.db.run(
        "UPDATE memories SET value = ?, source = ?, updated = CURRENT_TIMESTAMP WHERE type = ? AND key = ?",
        [entry.value, entry.source, entry.type, entry.key]
      );
      this.enforceLimit(entry.type, entry.source, ids);
    })();
  }

  // Imports entries once under a name. All or nothing: if any entry is
  // rejected, or the limit would drop any entry of this import, none are
  // saved and the import is not recorded. The record is written in the same
  // transaction, so a crash cannot import twice.
  // Returns false if an import with this name already ran.
  importOnce(name: string, entries: MemoryEntry[]): boolean {
    return this.db.transaction(() => {
      if (this.db.query("SELECT 1 FROM imports WHERE name = ?").get(name)) return false;
      const written: number[] = [];
      for (const entry of entries) written.push(this.insert(entry, written));
      this.db.run("INSERT INTO imports (name) VALUES (?)", [name]);
      return true;
    })();
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

  // Each type and source has its own size limit, so inferred entries never
  // push out explicit ones. For preference: keep the newest, drop the oldest.
  // For fact and learned: keep the oldest, drop the newest. If a row the
  // caller just wrote would be dropped, the write is rejected instead, so a
  // save never reports success and then disappears. Call inside a transaction.
  private enforceLimit(type: MemoryType, source: MemorySource, written: number[]): void {
    const limit = LIMITS[type];
    const order = type === "preference" ? "DESC" : "ASC";
    const rows = this.db
      .query(`SELECT id, key, value FROM memories WHERE type = ? AND source = ? ORDER BY id ${order}`)
      .all(type, source) as { id: number; key: string; value: string }[];

    let total = 0;
    const toDrop: number[] = [];
    for (const row of rows) {
      total += row.key.length + row.value.length;
      if (total > limit) toDrop.push(row.id);
    }
    if (toDrop.some((id) => written.includes(id))) {
      throw new MemoryRejected(`${type} memory is over its ${limit}-character limit: remove an entry first`);
    }
    for (const id of toDrop) {
      this.db.run("DELETE FROM memories WHERE id = ?", [id]);
    }
  }
}
