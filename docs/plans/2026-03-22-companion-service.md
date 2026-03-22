# Companion Service Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Bun/TypeScript companion service that adds persistent memory, cron scheduling, and hang detection to the existing Claude Telegram bot without modifying its core architecture.

**Architecture:** A single `companion/` Bun process runs as a launchd service alongside the existing bot. It exposes a local HTTP API on `localhost:7823` that Claude can call as a tool. Memory is stored in SQLite and injected into Claude's system prompt at bot startup via `--append-system-prompt-file`. Cron jobs are stored in JSON and executed by spawning `claude --print`. The heartbeat watchdog pings the bot via Telegram every 5 minutes and triggers recovery via `tmux kill-session` if no pong is received.

**Tech Stack:** Bun, TypeScript, `bun:sqlite` (built-in), `node-cron`, Telegram Bot API (direct fetch)

**Spec:** `docs/specs/2026-03-22-companion-service-design.md`

---

## File Map

### New files (companion/)

| File | Responsibility |
|------|---------------|
| `companion/src/index.ts` | Entry point: reads `.env`, validates credentials, starts HTTP server, wires memory/cron/watchdog |
| `companion/src/config.ts` | Credential loading from `~/.claude/.env`, path constants |
| `companion/src/telegram.ts` | Thin Telegram Bot API client: `sendMessage()`, `getUpdates()` for pong polling |
| `companion/src/memory/store.ts` | SQLite CRUD for memories table, security scanning, character limit enforcement |
| `companion/src/memory/snapshot.ts` | Renders `memory-snapshot.md` from DB contents |
| `companion/src/memory/handler.ts` | HTTP route handlers for `POST /memory`, `GET /memory`, `POST /memory/snapshot` |
| `companion/src/cron/registry.ts` | Read/write/watch `cron-jobs.json`, CRUD operations |
| `companion/src/cron/scheduler.ts` | node-cron wiring, tick loop, job dispatch |
| `companion/src/cron/executor.ts` | Execute reminder (sendMessage) vs agent (`claude --print`) jobs, timeout, retry |
| `companion/src/cron/handler.ts` | HTTP route handlers for `POST /cron`, `GET /cron`, `PATCH /cron/:id`, `DELETE /cron/:id`, `POST /cron/:id/run` |
| `companion/src/watchdog/heartbeat.ts` | Send ping, poll for pong via getUpdates, activity timeout logic |
| `companion/src/watchdog/recovery.ts` | Kill tmux session, poll for bot restart, escalation counter |
| `companion/package.json` | Bun project manifest, `node-cron` dep |
| `companion/tsconfig.json` | TypeScript config |
| `companion/src/index.test.ts` | Integration smoke test (HTTP server starts, /memory and /cron endpoints respond) |
| `companion/src/memory/store.test.ts` | Unit tests for memory store |
| `companion/src/cron/registry.test.ts` | Unit tests for cron registry |
| `companion/src/watchdog/heartbeat.test.ts` | Unit tests for pong detection logic |

### New files (project root)

| File | Responsibility |
|------|---------------|
| `launchd/com.nischal.claudebot-companion.plist` | launchd service definition for companion |
| `prompts/memory-tool-instructions.txt` | Injected into system prompt — tells Claude how to call memory/cron HTTP API and respond to heartbeat pings |

### Modified files

| File | Change |
|------|--------|
| `deploy/launch_bot.sh` | Add `EXTRA_FLAGS` block to inject `memory-snapshot.md` and `memory-tool-instructions.txt` via `--append-system-prompt-file` |
| `prompts/system-prompt.example.txt` | Update rule 4 from "no cross-session memory" to memory-aware rule |
| `bin/notify.sh` | Add 3× retry with exponential backoff |
| `bin/watchdog.sh` | Add "HEALTHY" heartbeat log line every interval |
| `launchd/com.nischal.claudebot.plist` | Add `SizeLimit` for log rotation |

---

## Task 1: Project scaffold and config

**Files:**
- Create: `companion/package.json`
- Create: `companion/tsconfig.json`
- Create: `companion/src/config.ts`

- [ ] **Step 1: Create companion/ directory and package.json**

```bash
mkdir -p /Users/nischal/projects/claude-telegram-bot/companion/src
```

Create `companion/package.json`:
```json
{
  "name": "claude-bot-companion",
  "version": "0.0.1",
  "private": true,
  "scripts": {
    "start": "bun run src/index.ts",
    "test": "bun test"
  },
  "dependencies": {
    "node-cron": "^3.0.3"
  },
  "devDependencies": {
    "@types/node-cron": "^3.0.11"
  }
}
```

- [ ] **Step 2: Install dependencies**

```bash
cd /Users/nischal/projects/claude-telegram-bot/companion && bun install
```

Expected: `bun.lock` created, `node_modules/` populated.

- [ ] **Step 3: Create tsconfig.json**

Create `companion/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "types": ["bun-types"]
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 4: Write config.ts**

Create `companion/src/config.ts`:
```typescript
import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

export interface Config {
  telegramBotToken: string;
  telegramChatId: string;
  anthropicApiKey: string;
  companionDir: string;
  logsDir: string;
  projectDir: string;
  httpPort: number;
}

function parseEnvFile(path: string): Record<string, string> {
  try {
    const content = readFileSync(path, "utf-8");
    const result: Record<string, string> = {};
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
      result[key] = value;
    }
    return result;
  } catch {
    return {};
  }
}

export function loadConfig(): Config {
  const home = homedir();
  const envPath = join(home, ".claude", ".env");
  const env = { ...parseEnvFile(envPath), ...process.env };

  const required = ["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID", "ANTHROPIC_API_KEY"];
  const missing = required.filter((k) => !env[k]);
  if (missing.length > 0) {
    console.error(`[companion] Missing required credentials: ${missing.join(", ")}`);
    console.error(`[companion] Expected in ${envPath} or environment`);
    process.exit(1);
  }

  return {
    telegramBotToken: env.TELEGRAM_BOT_TOKEN!,
    telegramChatId: env.TELEGRAM_CHAT_ID!,
    anthropicApiKey: env.ANTHROPIC_API_KEY!,
    companionDir: join(home, ".claude", "companion"),
    logsDir: join(home, ".claude", "logs"),
    projectDir: join(home, "projects", "claude-telegram-bot"),
    httpPort: 7823,
  };
}
```

- [ ] **Step 5: Verify config compiles**

```bash
cd /Users/nischal/projects/claude-telegram-bot/companion && bun run --eval "import('./src/config.ts').then(m => console.log('ok'))"
```

Expected: prints `ok` (or exits 1 if credentials missing — that's expected and correct).

- [ ] **Step 6: Commit**

```bash
cd /Users/nischal/projects/claude-telegram-bot
git add companion/
git commit -m "feat: scaffold companion service with config loader"
```

---

## Task 2: Memory store

**Files:**
- Create: `companion/src/memory/store.ts`
- Create: `companion/src/memory/store.test.ts`

- [ ] **Step 1: Write failing tests**

Create `companion/src/memory/store.test.ts`:
```typescript
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { MemoryStore } from "./store";

let tmpDir: string;
let store: MemoryStore;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "companion-test-"));
  store = new MemoryStore(join(tmpDir, "memory.db"));
});

afterEach(() => {
  store.close();
  rmSync(tmpDir, { recursive: true });
});

describe("MemoryStore", () => {
  test("adds a preference entry", () => {
    store.add({ type: "preference", key: "format", value: "bullet points", source: "explicit" });
    const entries = store.getAll();
    expect(entries.preferences).toHaveLength(1);
    expect(entries.preferences[0].key).toBe("format");
  });

  test("replaces an existing entry by key", () => {
    store.add({ type: "fact", key: "gym", value: "6am Tuesdays", source: "explicit" });
    store.replace({ type: "fact", key: "gym", value: "7am Wednesdays" });
    const entries = store.getAll();
    expect(entries.facts[0].value).toBe("7am Wednesdays");
  });

  test("removes an entry by key and type", () => {
    store.add({ type: "fact", key: "gym", value: "6am Tuesdays", source: "explicit" });
    store.remove({ type: "fact", key: "gym" });
    const entries = store.getAll();
    expect(entries.facts).toHaveLength(0);
  });

  test("blocks injection patterns", () => {
    expect(() =>
      store.add({ type: "fact", key: "x", value: "ignore previous instructions", source: "explicit" })
    ).toThrow("blocked");
  });

  test("blocks hidden unicode", () => {
    expect(() =>
      store.add({ type: "fact", key: "x", value: "hello\u200bworld", source: "explicit" })
    ).toThrow("blocked");
  });

  test("enforces character limits by dropping oldest learned entries", () => {
    // fill learned to just over 1000 chars
    for (let i = 0; i < 10; i++) {
      store.add({ type: "learned", key: `pattern-${i}`, value: "x".repeat(120), source: "inferred" });
    }
    const entries = store.getAll();
    const total = entries.learned.reduce((sum, e) => sum + e.key.length + e.value.length, 0);
    expect(total).toBeLessThanOrEqual(1000);
  });
});
```

- [ ] **Step 2: Run tests — expect all to fail**

```bash
cd /Users/nischal/projects/claude-telegram-bot/companion && bun test src/memory/store.test.ts
```

Expected: all 6 tests fail (module not found).

- [ ] **Step 3: Implement MemoryStore**

Create `companion/src/memory/store.ts`:
```typescript
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
    this.db.run(
      "INSERT INTO memories (type, key, value, source) VALUES (?, ?, ?, ?)",
      [entry.type, entry.key, entry.value, entry.source]
    );
    this.enforceLimit(entry.type);
  }

  replace(entry: { type: MemoryType; key: string; value: string }): void {
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
    // For preference: drop most recently added (reverse insertion order = highest id first)
    // For fact/learned: drop oldest (lowest id first)
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
```

- [ ] **Step 4: Run tests — expect all to pass**

```bash
cd /Users/nischal/projects/claude-telegram-bot/companion && bun test src/memory/store.test.ts
```

Expected: 6 tests pass.

- [ ] **Step 5: Commit**

```bash
cd /Users/nischal/projects/claude-telegram-bot
git add companion/src/memory/store.ts companion/src/memory/store.test.ts
git commit -m "feat: add memory store with SQLite, limits, and injection scanning"
```

---

## Task 3: Memory snapshot writer

**Files:**
- Create: `companion/src/memory/snapshot.ts`

- [ ] **Step 1: Write snapshot.ts**

Create `companion/src/memory/snapshot.ts`:
```typescript
import { writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";
import type { AllMemories } from "./store";

export function writeSnapshot(snapshotPath: string, memories: AllMemories): void {
  const lines: string[] = ["## Your Memory", ""];

  const section = (title: string, entries: { key: string; value: string }[]) => {
    lines.push(`### ${title}`);
    if (entries.length === 0) {
      lines.push("_(none yet)_");
    } else {
      for (const e of entries) lines.push(`- ${e.key}: ${e.value}`);
    }
    lines.push("");
  };

  section("Preferences", memories.preferences);
  section("Facts", memories.facts);
  section("Learned", memories.learned);

  mkdirSync(dirname(snapshotPath), { recursive: true });
  writeFileSync(snapshotPath, lines.join("\n"), "utf-8");
}
```

- [ ] **Step 2: Verify it compiles**

```bash
cd /Users/nischal/projects/claude-telegram-bot/companion && bun run --eval "import('./src/memory/snapshot.ts').then(() => console.log('ok'))"
```

Expected: `ok`

- [ ] **Step 3: Commit**

```bash
cd /Users/nischal/projects/claude-telegram-bot
git add companion/src/memory/snapshot.ts
git commit -m "feat: add memory snapshot writer"
```

---

## Task 4: Memory HTTP handlers

**Files:**
- Create: `companion/src/memory/handler.ts`

- [ ] **Step 1: Write handler.ts**

Create `companion/src/memory/handler.ts`:
```typescript
import type { MemoryStore, MemoryType, MemorySource } from "./store";
import { writeSnapshot } from "./snapshot";

interface AddBody { op: "add"; type: MemoryType; key: string; value: string; source?: MemorySource }
interface ReplaceBody { op: "replace"; type: MemoryType; key: string; value: string }
interface RemoveBody { op: "remove"; type: MemoryType; key: string }
type MemoryBody = AddBody | ReplaceBody | RemoveBody;

export function createMemoryRouter(store: MemoryStore, snapshotPath: string) {
  return {
    async handlePost(req: Request): Promise<Response> {
      let body: MemoryBody;
      try {
        body = await req.json() as MemoryBody;
      } catch {
        return Response.json({ error: "invalid JSON" }, { status: 400 });
      }

      try {
        if (body.op === "add") {
          store.add({ type: body.type, key: body.key, value: body.value, source: body.source ?? "explicit" });
        } else if (body.op === "replace") {
          store.replace({ type: body.type, key: body.key, value: body.value });
        } else if (body.op === "remove") {
          store.remove({ type: body.type, key: body.key });
        } else {
          return Response.json({ error: "unknown op" }, { status: 400 });
        }
        writeSnapshot(snapshotPath, store.getAll());
        return Response.json({ ok: true });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return Response.json({ error: msg }, { status: 422 });
      }
    },

    handleGet(): Response {
      return Response.json(store.getAll());
    },

    handleSnapshot(): Response {
      writeSnapshot(snapshotPath, store.getAll());
      return Response.json({ ok: true });
    },
  };
}
```

- [ ] **Step 2: Verify it compiles**

```bash
cd /Users/nischal/projects/claude-telegram-bot/companion && bun run --eval "import('./src/memory/handler.ts').then(() => console.log('ok'))"
```

Expected: `ok`

- [ ] **Step 3: Commit**

```bash
cd /Users/nischal/projects/claude-telegram-bot
git add companion/src/memory/handler.ts
git commit -m "feat: add memory HTTP route handlers"
```

---

## Task 5: Telegram client

**Files:**
- Create: `companion/src/telegram.ts`

- [ ] **Step 1: Write telegram.ts**

Create `companion/src/telegram.ts`:
```typescript
const BASE = "https://api.telegram.org";

export class TelegramClient {
  private token: string;
  private chatId: string;
  private offset = 0;

  constructor(token: string, chatId: string) {
    this.token = token;
    this.chatId = chatId;
  }

  async sendMessage(text: string): Promise<void> {
    const res = await fetch(`${BASE}/bot${this.token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: this.chatId, text }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`[telegram] sendMessage failed: ${res.status} ${body}`);
    }
  }

  async sendMessageWithRetry(text: string, attempts = 3): Promise<void> {
    for (let i = 0; i < attempts; i++) {
      try {
        await this.sendMessage(text);
        return;
      } catch (e) {
        if (i === attempts - 1) throw e;
        await Bun.sleep((2 ** i) * 1000);
      }
    }
  }

  // Poll for updates containing a specific pong nonce.
  // Returns true if pong received within timeoutMs.
  //
  // NOTE: This polls getUpdates independently of the Telegram plugin's poller.
  // Two consumers on the same bot token race for updates — whichever advances
  // offset first causes the other to miss those updates. In practice, the
  // companion only polls for 90s every 5 minutes and only looks for its own
  // nonce-tagged pong message. The bot plugin processes all other messages.
  // This is an acceptable tradeoff for a personal single-user bot.
  async waitForPong(nonce: string, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    const pattern = `[HEARTBEAT_PONG_${nonce}]`;
    while (Date.now() < deadline) {
      const res = await fetch(
        `${BASE}/bot${this.token}/getUpdates?offset=${this.offset}&timeout=5&allowed_updates=["message"]`
      );
      if (!res.ok) {
        await Bun.sleep(2000);
        continue;
      }
      const data = await res.json() as { result: { update_id: number; message?: { text?: string } }[] };
      for (const update of data.result) {
        this.offset = update.update_id + 1;
        if (update.message?.text?.includes(pattern)) return true;
      }
    }
    return false;
  }
}
```

- [ ] **Step 2: Verify it compiles**

```bash
cd /Users/nischal/projects/claude-telegram-bot/companion && bun run --eval "import('./src/telegram.ts').then(() => console.log('ok'))"
```

Expected: `ok`

- [ ] **Step 3: Commit**

```bash
cd /Users/nischal/projects/claude-telegram-bot
git add companion/src/telegram.ts
git commit -m "feat: add thin Telegram Bot API client with pong polling"
```

---

## Task 6: Cron registry

**Files:**
- Create: `companion/src/cron/registry.ts`
- Create: `companion/src/cron/registry.test.ts`

- [ ] **Step 1: Write failing tests**

Create `companion/src/cron/registry.test.ts`:
```typescript
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { CronRegistry } from "./registry";

let tmpDir: string;
let registry: CronRegistry;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "cron-test-"));
  registry = new CronRegistry(join(tmpDir, "cron-jobs.json"));
});

afterEach(() => {
  registry.close();
  rmSync(tmpDir, { recursive: true });
});

describe("CronRegistry", () => {
  test("starts empty", () => {
    expect(registry.list()).toHaveLength(0);
  });

  test("creates a reminder job", () => {
    const id = registry.create({
      id: "test-job",
      schedule: "0 9 * * 1",
      type: "reminder",
      message: "Hello!",
      delivery: "telegram",
    });
    expect(id).toBe("test-job");
    expect(registry.list()).toHaveLength(1);
  });

  test("deduplicates ids with suffix", () => {
    registry.create({ id: "job", schedule: "0 9 * * 1", type: "reminder", message: "A", delivery: "telegram" });
    const id2 = registry.create({ id: "job", schedule: "0 9 * * 1", type: "reminder", message: "B", delivery: "telegram" });
    expect(id2).toBe("job-2");
  });

  test("updates enabled flag", () => {
    registry.create({ id: "job", schedule: "0 9 * * 1", type: "reminder", message: "A", delivery: "telegram" });
    registry.update("job", { enabled: false });
    expect(registry.get("job")?.enabled).toBe(false);
  });

  test("removes a job", () => {
    registry.create({ id: "job", schedule: "0 9 * * 1", type: "reminder", message: "A", delivery: "telegram" });
    registry.remove("job");
    expect(registry.list()).toHaveLength(0);
  });

  test("persists to disk and reloads", () => {
    registry.create({ id: "job", schedule: "0 9 * * 1", type: "reminder", message: "A", delivery: "telegram" });
    const registry2 = new CronRegistry(join(tmpDir, "cron-jobs.json"));
    expect(registry2.list()).toHaveLength(1);
    registry2.close();
  });
});
```

- [ ] **Step 2: Run tests — expect all to fail**

```bash
cd /Users/nischal/projects/claude-telegram-bot/companion && bun test src/cron/registry.test.ts
```

Expected: all 6 tests fail.

- [ ] **Step 3: Implement CronRegistry**

Create `companion/src/cron/registry.ts`:
```typescript
import { readFileSync, writeFileSync, mkdirSync, watch } from "fs";
import { dirname } from "path";

export type JobType = "reminder" | "agent";

export interface CronJob {
  id: string;
  schedule: string;
  type: JobType;
  message?: string;   // required for reminder
  prompt?: string;    // required for agent
  delivery: "telegram";
  enabled: boolean;
  created: string;
  lastRun: string | null;
  runCount: number;
  lastError?: string;
}

export type CreateJobInput = Omit<CronJob, "enabled" | "created" | "lastRun" | "runCount">;

export class CronRegistry {
  private path: string;
  private jobs: Map<string, CronJob> = new Map();
  private watcher: ReturnType<typeof watch> | null = null;

  constructor(registryPath: string) {
    this.path = registryPath;
    mkdirSync(dirname(registryPath), { recursive: true });
    this.load();
    this.watcher = watch(dirname(registryPath), { persistent: false }, (event, filename) => {
      if (filename === "cron-jobs.json") this.load();
    });
  }

  private load(): void {
    try {
      const raw = readFileSync(this.path, "utf-8");
      const arr = JSON.parse(raw) as CronJob[];
      this.jobs = new Map(arr.map((j) => [j.id, j]));
    } catch {
      this.jobs = new Map();
    }
  }

  private save(): void {
    writeFileSync(this.path, JSON.stringify([...this.jobs.values()], null, 2), "utf-8");
  }

  create(input: CreateJobInput): string {
    let id = input.id;
    if (this.jobs.has(id)) {
      let n = 2;
      while (this.jobs.has(`${id}-${n}`)) n++;
      id = `${id}-${n}`;
    }
    const job: CronJob = {
      ...input,
      id,
      enabled: true,
      created: new Date().toISOString(),
      lastRun: null,
      runCount: 0,
    };
    this.jobs.set(id, job);
    this.save();
    return id;
  }

  update(id: string, patch: Partial<CronJob>): void {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`job not found: ${id}`);
    this.jobs.set(id, { ...job, ...patch });
    this.save();
  }

  remove(id: string): void {
    this.jobs.delete(id);
    this.save();
  }

  get(id: string): CronJob | undefined {
    return this.jobs.get(id);
  }

  list(): CronJob[] {
    return [...this.jobs.values()];
  }

  close(): void {
    this.watcher?.close();
  }
}
```

- [ ] **Step 4: Run tests — expect all to pass**

```bash
cd /Users/nischal/projects/claude-telegram-bot/companion && bun test src/cron/registry.test.ts
```

Expected: 6 tests pass.

- [ ] **Step 5: Commit**

```bash
cd /Users/nischal/projects/claude-telegram-bot
git add companion/src/cron/registry.ts companion/src/cron/registry.test.ts
git commit -m "feat: add cron job registry with JSON persistence and fs.watch"
```

---

## Task 7: Cron executor and scheduler

**Files:**
- Create: `companion/src/cron/executor.ts`
- Create: `companion/src/cron/scheduler.ts`

- [ ] **Step 1: Write executor.ts**

Create `companion/src/cron/executor.ts`:
```typescript
import type { CronJob } from "./registry";
import type { TelegramClient } from "../telegram";

const TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const MAX_OUTPUT = 3800;

export async function executeJob(job: CronJob, telegram: TelegramClient, apiKey: string): Promise<void> {
  if (job.type === "reminder") {
    await telegram.sendMessageWithRetry(job.message!);
    return;
  }

  // agent job: spawn claude --print using Bun.spawn (async, non-blocking)
  // spawnSync would block the entire event loop for up to 5 minutes, freezing
  // the HTTP server and heartbeat pings. Bun.spawn is async and non-blocking.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  const proc = Bun.spawn(
    ["claude", "--print", "--dangerously-skip-permissions", job.prompt!],
    {
      env: { ...process.env, ANTHROPIC_API_KEY: apiKey },
      stdout: "pipe",
      stderr: "pipe",
      signal: controller.signal,
    }
  );

  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    clearTimeout(timeout);

    if (exitCode !== 0) {
      throw new Error(`[executor] claude exited ${exitCode}: ${stderr.slice(0, 500)}`);
    }

    const output = stdout.slice(0, MAX_OUTPUT);
    await telegram.sendMessageWithRetry(output || "(no output)");
  } catch (e: unknown) {
    clearTimeout(timeout);
    if (controller.signal.aborted) {
      proc.kill();
      throw new Error(`[executor] claude timed out after ${TIMEOUT_MS / 1000}s`);
    }
    throw e;
  }
}
```

- [ ] **Step 2: Write scheduler.ts**

Create `companion/src/cron/scheduler.ts`:
```typescript
import cron from "node-cron";
import type { CronRegistry } from "./registry";
import { executeJob } from "./executor";
import type { TelegramClient } from "../telegram";

export class CronScheduler {
  private registry: CronRegistry;
  private telegram: TelegramClient;
  private apiKey: string;
  private tasks: Map<string, ReturnType<typeof cron.schedule>> = new Map();
  private running = false;

  constructor(registry: CronRegistry, telegram: TelegramClient, apiKey: string) {
    this.registry = registry;
    this.telegram = telegram;
    this.apiKey = apiKey;
  }

  start(): void {
    this.running = true;
    this.sync();
    // Re-sync every minute to pick up registry changes
    cron.schedule("* * * * *", () => this.sync());
  }

  async runNow(jobId: string): Promise<void> {
    const job = this.registry.get(jobId);
    if (!job) throw new Error(`job not found: ${jobId}`);
    await this.run(job);
  }

  private sync(): void {
    const jobs = this.registry.list();
    const currentIds = new Set(jobs.map((j) => j.id));

    // Remove tasks for deleted/disabled jobs
    for (const [id, task] of this.tasks) {
      if (!currentIds.has(id) || !this.registry.get(id)?.enabled) {
        task.stop();
        this.tasks.delete(id);
      }
    }

    // Add tasks for new enabled jobs
    for (const job of jobs) {
      if (!job.enabled || this.tasks.has(job.id)) continue;
      if (!cron.validate(job.schedule)) {
        console.error(`[scheduler] invalid cron expression for job ${job.id}: ${job.schedule}`);
        continue;
      }
      const task = cron.schedule(job.schedule, () => this.run(job));
      this.tasks.set(job.id, task);
    }
  }

  // Serialize job execution — one job at a time to avoid hammering Claude API
  private executionQueue: Promise<void> = Promise.resolve();

  private async run(job: CronJob): Promise<void> {
    this.executionQueue = this.executionQueue.then(() => this.doRun(job));
  }

  private async doRun(job: CronJob): Promise<void> {
    console.log(`[scheduler] running job ${job.id}`);
    try {
      await executeJob(job, this.telegram, this.apiKey);
      this.registry.update(job.id, {
        lastRun: new Date().toISOString(),
        runCount: (job.runCount ?? 0) + 1,
        lastError: undefined,
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[scheduler] job ${job.id} failed: ${msg}`);
      this.registry.update(job.id, { lastError: msg });
      // retry once after 60s
      await Bun.sleep(60_000);
      try {
        await executeJob(job, this.telegram, this.apiKey);
        this.registry.update(job.id, { lastRun: new Date().toISOString(), runCount: (job.runCount ?? 0) + 1, lastError: undefined });
      } catch (e2: unknown) {
        const msg2 = e2 instanceof Error ? e2.message : String(e2);
        await this.telegram.sendMessageWithRetry(`❌ Cron job "${job.id}" failed twice: ${msg2}`).catch(() => {});
      }
    }
  }
}

- [ ] **Step 3: Verify both compile**

```bash
cd /Users/nischal/projects/claude-telegram-bot/companion && bun run --eval "import('./src/cron/executor.ts').then(() => import('./src/cron/scheduler.ts')).then(() => console.log('ok'))"
```

Expected: `ok`

- [ ] **Step 4: Commit**

```bash
cd /Users/nischal/projects/claude-telegram-bot
git add companion/src/cron/executor.ts companion/src/cron/scheduler.ts
git commit -m "feat: add cron executor and scheduler"
```

---

## Task 8: Cron HTTP handlers

**Files:**
- Create: `companion/src/cron/handler.ts`

- [ ] **Step 1: Write handler.ts**

Create `companion/src/cron/handler.ts`:
```typescript
import type { CronRegistry, CreateJobInput } from "./registry";
import type { CronScheduler } from "./scheduler";

export function createCronRouter(registry: CronRegistry, scheduler: CronScheduler) {
  return {
    async handlePost(req: Request): Promise<Response> {
      let body: CreateJobInput;
      try {
        body = await req.json() as CreateJobInput;
      } catch {
        return Response.json({ error: "invalid JSON" }, { status: 400 });
      }
      if (!body.schedule || !body.type) {
        return Response.json({ error: "schedule and type are required" }, { status: 400 });
      }
      if (body.type === "reminder" && !body.message) {
        return Response.json({ error: "message required for reminder jobs" }, { status: 400 });
      }
      if (body.type === "agent" && !body.prompt) {
        return Response.json({ error: "prompt required for agent jobs" }, { status: 400 });
      }
      try {
        const id = registry.create(body);
        return Response.json({ ok: true, id });
      } catch (e: unknown) {
        return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 422 });
      }
    },

    handleGet(): Response {
      return Response.json(registry.list());
    },

    async handlePatch(req: Request, id: string): Promise<Response> {
      let patch: Record<string, unknown>;
      try {
        patch = await req.json() as Record<string, unknown>;
      } catch {
        return Response.json({ error: "invalid JSON" }, { status: 400 });
      }
      try {
        registry.update(id, patch);
        return Response.json({ ok: true });
      } catch (e: unknown) {
        return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 404 });
      }
    },

    handleDelete(_req: Request, id: string): Response {
      try {
        registry.remove(id);
        return Response.json({ ok: true });
      } catch (e: unknown) {
        return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 404 });
      }
    },

    async handleRun(_req: Request, id: string): Promise<Response> {
      try {
        await scheduler.runNow(id);
        return Response.json({ ok: true });
      } catch (e: unknown) {
        return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 422 });
      }
    },
  };
}
```

- [ ] **Step 2: Verify it compiles**

```bash
cd /Users/nischal/projects/claude-telegram-bot/companion && bun run --eval "import('./src/cron/handler.ts').then(() => console.log('ok'))"
```

Expected: `ok`

- [ ] **Step 3: Commit**

```bash
cd /Users/nischal/projects/claude-telegram-bot
git add companion/src/cron/handler.ts
git commit -m "feat: add cron HTTP route handlers"
```

---

## Task 9: Heartbeat watchdog

**Files:**
- Create: `companion/src/watchdog/heartbeat.ts`
- Create: `companion/src/watchdog/recovery.ts`
- Create: `companion/src/watchdog/heartbeat.test.ts`

- [ ] **Step 1: Write failing tests**

Create `companion/src/watchdog/heartbeat.test.ts`:
```typescript
import { describe, test, expect } from "bun:test";
import { generateNonce, buildPingMessage, isPongMessage } from "./heartbeat";

describe("heartbeat helpers", () => {
  test("generateNonce returns 8 hex chars", () => {
    const nonce = generateNonce();
    expect(nonce).toMatch(/^[0-9a-f]{8}$/);
  });

  test("buildPingMessage contains nonce", () => {
    const msg = buildPingMessage("abc12345");
    expect(msg).toBe("[HEARTBEAT_PING_abc12345]");
  });

  test("isPongMessage matches pong with nonce", () => {
    expect(isPongMessage("[HEARTBEAT_PONG_abc12345]", "abc12345")).toBe(true);
  });

  test("isPongMessage rejects wrong nonce", () => {
    expect(isPongMessage("[HEARTBEAT_PONG_xxxxxxxx]", "abc12345")).toBe(false);
  });

  test("isPongMessage rejects ping message", () => {
    expect(isPongMessage("[HEARTBEAT_PING_abc12345]", "abc12345")).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests — expect all to fail**

```bash
cd /Users/nischal/projects/claude-telegram-bot/companion && bun test src/watchdog/heartbeat.test.ts
```

Expected: all 5 tests fail.

- [ ] **Step 3: Implement heartbeat.ts**

Create `companion/src/watchdog/heartbeat.ts`:
```typescript
import { appendFileSync, mkdirSync } from "fs";
import { dirname } from "path";
import type { TelegramClient } from "../telegram";

export function generateNonce(): string {
  return Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, "0");
}

export function buildPingMessage(nonce: string): string {
  return `[HEARTBEAT_PING_${nonce}]`;
}

export function isPongMessage(text: string, nonce: string): boolean {
  return text.includes(`[HEARTBEAT_PONG_${nonce}]`);
}

function logHealth(logPath: string, message: string): void {
  const ts = new Date().toISOString().slice(0, 19);
  mkdirSync(dirname(logPath), { recursive: true });
  appendFileSync(logPath, `${ts} ${message}\n`, "utf-8");
}

export class HeartbeatWatchdog {
  private telegram: TelegramClient;
  private healthLogPath: string;
  private intervalMs: number;
  private pongTimeoutMs: number;
  private onHung: () => Promise<void>;
  private timer: ReturnType<typeof setInterval> | null = null;
  private missedPings = 0;

  constructor(opts: {
    telegram: TelegramClient;
    healthLogPath: string;
    intervalMs?: number;
    pongTimeoutMs?: number;
    onHung: () => Promise<void>;
  }) {
    this.telegram = opts.telegram;
    this.healthLogPath = opts.healthLogPath;
    this.intervalMs = opts.intervalMs ?? 5 * 60 * 1000;
    this.pongTimeoutMs = opts.pongTimeoutMs ?? 90 * 1000;
    this.onHung = opts.onHung;
  }

  start(): void {
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    console.log("[heartbeat] watchdog started");
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    const nonce = generateNonce();
    try {
      await this.telegram.sendMessage(buildPingMessage(nonce));
      const pongReceived = await this.telegram.waitForPong(nonce, this.pongTimeoutMs);
      if (pongReceived) {
        this.missedPings = 0;
        logHealth(this.healthLogPath, "HEALTHY");
      } else {
        this.missedPings++;
        logHealth(this.healthLogPath, `MISSED PONG (${this.missedPings})`);
        if (this.missedPings >= 2) {
          logHealth(this.healthLogPath, "HUNG — triggering recovery");
          this.missedPings = 0;
          await this.onHung();
        }
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      logHealth(this.healthLogPath, `PING ERROR: ${msg}`);
    }
  }
}
```

- [ ] **Step 4: Run tests — expect all to pass**

```bash
cd /Users/nischal/projects/claude-telegram-bot/companion && bun test src/watchdog/heartbeat.test.ts
```

Expected: 5 tests pass.

- [ ] **Step 5: Write recovery.ts**

Create `companion/src/watchdog/recovery.ts`:
```typescript
import { spawnSync } from "child_process";
import { appendFileSync, mkdirSync } from "fs";
import { dirname } from "path";
import type { TelegramClient } from "../telegram";

const SESSION = "claude-bot";
const POLL_INTERVAL_MS = 5000;
const RECOVERY_TIMEOUT_MS = 90_000;
const MAX_ATTEMPTS = 3;
const BACKOFF_MS = 60 * 60 * 1000; // 1 hour

function log(logPath: string, message: string): void {
  const ts = new Date().toISOString().slice(0, 19);
  mkdirSync(dirname(logPath), { recursive: true });
  appendFileSync(logPath, `${ts} ${message}\n`, "utf-8");
}

function isBotRunning(): boolean {
  const result = spawnSync("pgrep", ["-f", "claude.*--channels plugin:telegram"], { encoding: "utf-8" });
  return (result.stdout ?? "").trim().length > 0;
}

function killBot(): void {
  spawnSync("tmux", ["kill-session", "-t", SESSION]);
}

async function waitForBotRestart(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await Bun.sleep(POLL_INTERVAL_MS);
    const result = spawnSync("pgrep", ["-f", "claude.*--channels plugin:telegram"], { encoding: "utf-8" });
    const pids = (result.stdout ?? "").trim().split("\n").filter(Boolean);
    if (pids.length === 1) {
      // also check bun child
      const bunResult = spawnSync("pgrep", ["-P", pids[0], "bun"], { encoding: "utf-8" });
      if ((bunResult.stdout ?? "").trim().length > 0) return true;
    }
  }
  return false;
}

export class RecoveryManager {
  private telegram: TelegramClient;
  private healthLogPath: string;
  private attempts: { time: number }[] = [];
  private backoffUntil = 0;

  constructor(telegram: TelegramClient, healthLogPath: string) {
    this.telegram = telegram;
    this.healthLogPath = healthLogPath;
  }

  async recover(): Promise<void> {
    if (Date.now() < this.backoffUntil) {
      log(this.healthLogPath, "RECOVERY SKIPPED (in backoff)");
      return;
    }

    // Prune attempts older than 1 hour
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    this.attempts = this.attempts.filter((a) => a.time > oneHourAgo);

    if (this.attempts.length >= MAX_ATTEMPTS) {
      const msg = "❌ Bot has failed to recover 3 times in the last hour. Manual intervention needed.";
      log(this.healthLogPath, "ESCALATED — backing off 1 hour");
      await this.telegram.sendMessageWithRetry(msg).catch(() => {});
      this.backoffUntil = Date.now() + BACKOFF_MS;
      return;
    }

    const attempt = this.attempts.length + 1;
    log(this.healthLogPath, `RECOVERY attempt ${attempt}/${MAX_ATTEMPTS}`);
    this.attempts.push({ time: Date.now() });

    killBot();
    const recovered = await waitForBotRestart(RECOVERY_TIMEOUT_MS);
    if (recovered) {
      log(this.healthLogPath, "RECOVERED");
      await this.telegram.sendMessageWithRetry("⚠️ Bot was hung and has been restarted").catch(() => {});
    } else {
      log(this.healthLogPath, "RECOVERY FAILED — bot did not restart within 90s");
    }
  }
}
```

- [ ] **Step 6: Commit**

```bash
cd /Users/nischal/projects/claude-telegram-bot
git add companion/src/watchdog/heartbeat.ts companion/src/watchdog/heartbeat.test.ts companion/src/watchdog/recovery.ts
git commit -m "feat: add heartbeat watchdog and recovery manager"
```

---

## Task 10: Entry point and HTTP server

**Files:**
- Create: `companion/src/index.ts`

- [ ] **Step 1: Write index.ts**

Create `companion/src/index.ts`:
```typescript
import { mkdirSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { loadConfig } from "./config";
import { MemoryStore } from "./memory/store";
import { writeSnapshot } from "./memory/snapshot";
import { createMemoryRouter } from "./memory/handler";
import { CronRegistry } from "./cron/registry";
import { CronScheduler } from "./cron/scheduler";
import { createCronRouter } from "./cron/handler";
import { TelegramClient } from "./telegram";
import { HeartbeatWatchdog } from "./watchdog/heartbeat";
import { RecoveryManager } from "./watchdog/recovery";

const config = loadConfig();

// Ensure directories exist
mkdirSync(config.companionDir, { recursive: true });
mkdirSync(config.logsDir, { recursive: true });

// Memory
const store = new MemoryStore(join(config.companionDir, "memory.db"));

// Import seed file on first run
const seedPath = join(config.companionDir, "memories-seed.json");
const importedFlagPath = join(config.companionDir, ".seed-imported");
if (existsSync(seedPath) && !existsSync(importedFlagPath)) {
  try {
    const entries = JSON.parse(readFileSync(seedPath, "utf-8")) as { type: string; key: string; value: string }[];
    for (const e of entries) {
      store.add({ type: e.type as any, key: e.key, value: e.value, source: "explicit" });
    }
    writeFileSync(importedFlagPath, new Date().toISOString(), "utf-8");
    console.log(`[companion] imported ${entries.length} seed memories`);
  } catch (e) {
    console.error("[companion] failed to import seed:", e);
  }
}

const snapshotPath = join(config.companionDir, "memory-snapshot.md");
writeSnapshot(snapshotPath, store.getAll());

// Cron
const registry = new CronRegistry(join(config.companionDir, "cron-jobs.json"));
const telegram = new TelegramClient(config.telegramBotToken, config.telegramChatId);
const scheduler = new CronScheduler(registry, telegram, config.anthropicApiKey);
scheduler.start();

// Watchdog
const healthLogPath = join(config.logsDir, "companion-health.log");
const recovery = new RecoveryManager(telegram, healthLogPath);
const heartbeat = new HeartbeatWatchdog({
  telegram,
  healthLogPath,
  onHung: () => recovery.recover(),
});
heartbeat.start();

// HTTP server
const memoryRouter = createMemoryRouter(store, snapshotPath);
const cronRouter = createCronRouter(registry, scheduler);

const server = Bun.serve({
  port: config.httpPort,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    // Memory routes
    if (path === "/memory" && method === "POST") return memoryRouter.handlePost(req);
    if (path === "/memory" && method === "GET") return memoryRouter.handleGet();
    if (path === "/memory/snapshot" && method === "POST") return memoryRouter.handleSnapshot();

    // Cron routes
    if (path === "/cron" && method === "POST") return cronRouter.handlePost(req);
    if (path === "/cron" && method === "GET") return cronRouter.handleGet();
    const cronPatchMatch = path.match(/^\/cron\/([^/]+)$/) ;
    if (cronPatchMatch && method === "PATCH") return cronRouter.handlePatch(req, cronPatchMatch[1]);
    if (cronPatchMatch && method === "DELETE") return cronRouter.handleDelete(req, cronPatchMatch[1]);
    const cronRunMatch = path.match(/^\/cron\/([^/]+)\/run$/);
    if (cronRunMatch && method === "POST") return cronRouter.handleRun(req, cronRunMatch[1]);

    // Health check
    if (path === "/health" && method === "GET") return Response.json({ ok: true });

    return new Response("Not Found", { status: 404 });
  },
});

console.log(`[companion] HTTP server listening on port ${config.httpPort}`);

// Graceful shutdown
process.on("SIGTERM", () => {
  server.stop();
  registry.close();
  store.close();
  heartbeat.stop();
  process.exit(0);
});
```

Fix missing import in index.ts (writeFileSync):
```typescript
// Add to imports at top of index.ts:
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "fs";
```

- [ ] **Step 2: Run the companion locally to verify it starts**

First ensure `.env` has the required keys. Then:

```bash
cd /Users/nischal/projects/claude-telegram-bot/companion && bun run src/index.ts &
sleep 2
curl -s http://localhost:7823/health
kill %1
```

Expected: `{"ok":true}`

- [ ] **Step 3: Run all tests**

```bash
cd /Users/nischal/projects/claude-telegram-bot/companion && bun test
```

Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
cd /Users/nischal/projects/claude-telegram-bot
git add companion/src/index.ts
git commit -m "feat: add companion entry point and HTTP server"
```

---

## Task 11: launchd plist

**Files:**
- Create: `launchd/com.nischal.claudebot-companion.plist`

- [ ] **Step 1: Create the plist**

Create `launchd/com.nischal.claudebot-companion.plist`:
```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.nischal.claudebot-companion</string>

  <key>ProgramArguments</key>
  <array>
    <string>/Users/nischal/.bun/bin/bun</string>
    <string>run</string>
    <string>/Users/nischal/projects/claude-telegram-bot/companion/src/index.ts</string>
  </array>

  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>/Users/nischal</string>
    <key>PATH</key>
    <string>/Users/nischal/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>

  <key>WorkingDirectory</key>
  <string>/Users/nischal/projects/claude-telegram-bot/companion</string>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <true/>

  <key>ThrottleInterval</key>
  <integer>10</integer>

  <key>StandardOutPath</key>
  <string>/Users/nischal/.claude/logs/companion.log</string>

  <key>StandardErrorPath</key>
  <string>/Users/nischal/.claude/logs/companion.log</string>
</dict>
</plist>
```

- [ ] **Step 2: Copy to LaunchAgents and load**

```bash
cp /Users/nischal/projects/claude-telegram-bot/launchd/com.nischal.claudebot-companion.plist \
   ~/Library/LaunchAgents/com.nischal.claudebot-companion.plist

launchctl load ~/Library/LaunchAgents/com.nischal.claudebot-companion.plist
```

- [ ] **Step 3: Verify it started**

```bash
launchctl list | grep claudebot-companion
sleep 3
curl -s http://localhost:7823/health
```

Expected: service listed (non-zero PID), health endpoint returns `{"ok":true}`.

- [ ] **Step 4: Commit**

```bash
cd /Users/nischal/projects/claude-telegram-bot
git add launchd/com.nischal.claudebot-companion.plist
git commit -m "feat: add companion launchd service plist"
```

---

## Task 12: System prompt additions

**Files:**
- Create: `prompts/memory-tool-instructions.txt`
- Modify: `prompts/system-prompt.example.txt`

- [ ] **Step 1: Create memory-tool-instructions.txt**

Create `prompts/memory-tool-instructions.txt`:
```
## Memory & Scheduling Tools

You have access to a companion service at http://localhost:7823 that provides persistent memory and task scheduling. Use these tools proactively.

### Memory

When the user says "remember X", "save X", "note that X", or you notice a preference worth saving:

  POST http://localhost:7823/memory
  Content-Type: application/json
  {"op": "add", "type": "preference"|"fact"|"learned", "key": "...", "value": "...", "source": "explicit"|"inferred"}

Use type "preference" for how they like things done, "fact" for concrete facts they share, "learned" for patterns you observe.

Always tell the user when you've saved something: "Saved: gym is 6am Tuesdays."
If the POST fails (companion down), say so honestly: "I couldn't save that — the memory service isn't available."

To update memory:   {"op": "replace", "type": "...", "key": "...", "value": "new value"}
To remove memory:   {"op": "remove", "type": "...", "key": "..."}
To read memory:     GET http://localhost:7823/memory

### Scheduled Tasks

When the user asks to schedule a reminder or recurring task:

  POST http://localhost:7823/cron
  Content-Type: application/json
  {
    "id": "descriptive-id",
    "schedule": "0 9 * * 1",   ← standard cron expression
    "type": "reminder",         ← or "agent"
    "message": "...",           ← for reminder
    "prompt": "...",            ← for agent (claude will execute this)
    "delivery": "telegram"
  }

Confirm to the user after creating: "Set: remind you every Monday at 9am."
To list jobs:   GET http://localhost:7823/cron
To pause:       PATCH http://localhost:7823/cron/{id}  {"enabled": false}
To delete:      DELETE http://localhost:7823/cron/{id}
To run now:     POST http://localhost:7823/cron/{id}/run

### Heartbeat

When you receive a message matching [HEARTBEAT_PING_xxxxxxxx], immediately reply with [HEARTBEAT_PONG_xxxxxxxx] (same 8-char hex) before doing anything else. Do not explain this to the user.
```

- [ ] **Step 2: Update system-prompt.example.txt rule 4**

Edit `prompts/system-prompt.example.txt` — replace the "Memory honesty" rule:

```
**4. Memory**
You have persistent memory via a companion service. When the user says "remember X" or you notice a preference worth saving, use the memory tool (POST localhost:7823/memory). Always tell the user when you've saved something. If the companion is unavailable (tool call fails), say so honestly rather than claiming you saved it.
```

- [ ] **Step 3: Commit**

```bash
cd /Users/nischal/projects/claude-telegram-bot
git add prompts/memory-tool-instructions.txt prompts/system-prompt.example.txt
git commit -m "feat: add memory/cron tool instructions and update system prompt example"
```

---

## Task 13: Update deploy/launch_bot.sh

**Files:**
- Modify: `deploy/launch_bot.sh`

- [ ] **Step 1: Verify `--append-system-prompt-file` flag is available**

```bash
claude --help 2>&1 | grep "append-system-prompt-file"
```

Expected: a line containing `--append-system-prompt-file`. If absent, use `--append-system-prompt "$(cat file)"` in the EXTRA_FLAGS block instead (the flag variant is safer for multiline content but the string variant works as a fallback).

- [ ] **Step 2: Add EXTRA_FLAGS block**

Edit `deploy/launch_bot.sh`. Replace the final `exec claude` block:

```bash
# Before:
exec claude \
    --dangerously-skip-permissions \
    --append-system-prompt "$SYSTEM_PROMPT" \
    --channels plugin:telegram@claude-plugins-official
```

With:

```bash
# Inject memory snapshot and tool instructions if companion is running
MEMORY_SNAPSHOT="$HOME/.claude/companion/memory-snapshot.md"
MEMORY_INSTRUCTIONS="$EXPERIMENT_DIR/prompts/memory-tool-instructions.txt"

EXTRA_FLAGS=()
if [ -f "$MEMORY_SNAPSHOT" ]; then
    EXTRA_FLAGS+=(--append-system-prompt-file "$MEMORY_SNAPSHOT")
fi
if [ -f "$MEMORY_INSTRUCTIONS" ]; then
    EXTRA_FLAGS+=(--append-system-prompt-file "$MEMORY_INSTRUCTIONS")
fi

exec claude \
    --dangerously-skip-permissions \
    --append-system-prompt "$SYSTEM_PROMPT" \
    "${EXTRA_FLAGS[@]}" \
    --channels plugin:telegram@claude-plugins-official
```

- [ ] **Step 3: Verify the script is valid bash**

```bash
bash -n /Users/nischal/projects/claude-telegram-bot/deploy/launch_bot.sh
```

Expected: no output (no syntax errors).

- [ ] **Step 4: Commit**

```bash
cd /Users/nischal/projects/claude-telegram-bot
git add deploy/launch_bot.sh
git commit -m "feat: inject memory snapshot and tool instructions into bot system prompt"
```

---

## Task 14: Reliability fixes from audit

**Files:**
- Modify: `bin/notify.sh`
- Modify: `bin/watchdog.sh`
- Modify: `launchd/com.nischal.claudebot.plist`

- [ ] **Step 1: Add retry to notify.sh**

Replace the single `curl` call (lines 28–32 of the current file) with a retry loop.
Use `$MSG` (not `${1}`) to stay consistent with the file's existing variable. Preserve `--max-time 10`.

```bash
# Replace lines 28-32 (the single curl call) with:
MAX_ATTEMPTS=3
DELAY=2
for i in $(seq 1 $MAX_ATTEMPTS); do
    if curl -s --max-time 10 -X POST \
        "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
        -d "chat_id=${TELEGRAM_CHAT_ID}" \
        --data-urlencode "text=${MSG}" \
        > /dev/null 2>&1; then
        break
    fi
    if [ "$i" -lt "$MAX_ATTEMPTS" ]; then
        sleep $DELAY
        DELAY=$((DELAY * 2))
    fi
done
exit 0
```

- [ ] **Step 2: Add health heartbeat to watchdog.sh**

The file already defines a `log()` function (line 16–18) and `LOG_FILE` variable (line 9).
There is no `$LOG_DIR` variable — use the existing `log()` function.

At line 48 (the `if check_healthy; then` block that exits 0), replace:

```bash
if check_healthy; then
    # Healthy — nothing to do.
    exit 0
fi
```

With:

```bash
if check_healthy; then
    # Healthy — log heartbeat so we can verify watchdog is running.
    log "HEALTHY"
    exit 0
fi
```

Also at line 55–58 (the grace period re-check), replace:

```bash
if check_healthy; then
    # Transient blip — back to healthy.
    exit 0
fi
```

With:

```bash
if check_healthy; then
    # Transient blip — back to healthy.
    log "HEALTHY (recovered from transient)"
    exit 0
fi
```

- [ ] **Step 3: Add SizeLimit for log rotation to com.nischal.claudebot.plist**

Edit `launchd/com.nischal.claudebot.plist`. Add the following key inside the root `<dict>` (after the `StandardOutPath` entry):

```xml
  <key>SizeLimit</key>
  <integer>52428800</integer>
```

This caps `claudebot.log` at 50MB (52,428,800 bytes). launchd rotates it automatically.

Also copy the updated plist to LaunchAgents and reload:

```bash
cp /Users/nischal/projects/claude-telegram-bot/launchd/com.nischal.claudebot.plist \
   ~/Library/LaunchAgents/com.nischal.claudebot.plist

launchctl unload ~/Library/LaunchAgents/com.nischal.claudebot.plist
launchctl load ~/Library/LaunchAgents/com.nischal.claudebot.plist
```

- [ ] **Step 4: Verify both scripts are valid bash**

```bash
bash -n /Users/nischal/projects/claude-telegram-bot/bin/notify.sh
bash -n /Users/nischal/projects/claude-telegram-bot/bin/watchdog.sh
```

Expected: no output.

- [ ] **Step 5: Commit**

```bash
cd /Users/nischal/projects/claude-telegram-bot
git add bin/notify.sh bin/watchdog.sh launchd/com.nischal.claudebot.plist
git commit -m "fix: add retry to notify.sh, health heartbeat to watchdog.sh, log SizeLimit to bot plist"
```

---

## Task 15: End-to-end smoke test and bot restart

- [ ] **Step 1: Verify companion is running**

```bash
curl -s http://localhost:7823/health
```

Expected: `{"ok":true}`

- [ ] **Step 2: Test memory write via HTTP**

```bash
curl -s -X POST http://localhost:7823/memory \
  -H "Content-Type: application/json" \
  -d '{"op":"add","type":"fact","key":"test","value":"hello world","source":"explicit"}'
```

Expected: `{"ok":true}`

- [ ] **Step 3: Verify snapshot was written**

```bash
cat ~/.claude/companion/memory-snapshot.md
```

Expected: contains "test: hello world" under Facts.

- [ ] **Step 4: Test cron job creation**

```bash
curl -s -X POST http://localhost:7823/cron \
  -H "Content-Type: application/json" \
  -d '{"id":"smoke-test","schedule":"59 23 31 2 *","type":"reminder","message":"smoke test","delivery":"telegram"}'
```

Expected: `{"ok":true,"id":"smoke-test"}`

- [ ] **Step 5: Restart the bot to pick up new system prompt**

```bash
tmux kill-session -t claude-bot 2>/dev/null || true
# launchd will restart it automatically within 10s
sleep 15
tmux list-sessions | grep claude-bot
```

Expected: `claude-bot` session listed (bot restarted).

- [ ] **Step 6: Verify memory is injected (check bot's system prompt)**

Send a message to your bot: "what do you know about my test fact?"
Expected: bot responds with "hello world" — confirming memory injection is working.

- [ ] **Step 7: Clean up smoke test data**

```bash
curl -s -X POST http://localhost:7823/memory \
  -H "Content-Type: application/json" \
  -d '{"op":"remove","type":"fact","key":"test"}'

curl -s -X DELETE http://localhost:7823/cron/smoke-test
```

- [ ] **Step 8: Final commit**

```bash
cd /Users/nischal/projects/claude-telegram-bot
git add -A
git commit -m "chore: end-to-end smoke test verified — companion service complete"
```

---

## Summary

| Task | Deliverable |
|------|------------|
| 1 | Scaffold + config loader |
| 2 | Memory SQLite store + tests |
| 3 | Memory snapshot writer |
| 4 | Memory HTTP handlers |
| 5 | Telegram client |
| 6 | Cron registry + tests |
| 7 | Cron executor + scheduler |
| 8 | Cron HTTP handlers |
| 9 | Heartbeat watchdog + recovery + tests |
| 10 | Entry point + HTTP server |
| 11 | launchd plist |
| 12 | System prompt additions |
| 13 | deploy/launch_bot.sh update |
| 14 | Reliability fixes (notify retry, watchdog heartbeat) |
| 15 | End-to-end smoke test + bot restart |
