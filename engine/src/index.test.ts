import { describe, test, expect, afterAll } from "bun:test";

// Must be set before index.ts module loads and calls loadConfig()
process.env.COMPANION_TEST_PORT = "7824";
process.env.TELEGRAM_BOT_TOKEN = "test-token";
process.env.TELEGRAM_CHAT_ID = "123456";
process.env.ANTHROPIC_API_KEY = "test-key";

import { buildFetchHandler } from "./index";
import { MemoryStore } from "./memory/store";
import { CronRegistry } from "./cron/registry";
import { CronScheduler } from "./cron/scheduler";
import { createMemoryRouter } from "./memory/handler";
import { createCronRouter } from "./cron/handler";
import { TelegramClient } from "./telegram";
import { mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

// Set up isolated test fixtures
const testDir = join(homedir(), ".claude", "engine-test");
mkdirSync(testDir, { recursive: true });

const store = new MemoryStore(join(testDir, "test-memory.db"));
const registry = new CronRegistry(join(testDir, "test-cron-jobs.json"));
const telegram = new TelegramClient("test-token", "123456");
const scheduler = new CronScheduler(registry, telegram, "test-key");
const snapshotPath = join(testDir, "test-snapshot.md");

const memoryRouter = createMemoryRouter(store, snapshotPath);
const cronRouter = createCronRouter(registry, scheduler);
const handler = buildFetchHandler(memoryRouter, cronRouter);

// Helper to make mock requests
function makeRequest(method: string, path: string, body?: unknown): Request {
  const url = `http://localhost:7824${path}`;
  if (body !== undefined) {
    return new Request(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }
  return new Request(url, { method });
}

afterAll(() => {
  store.close();
  registry.close();
});

describe("engine HTTP server", () => {
  test("GET /health returns ok", async () => {
    const res = await handler(makeRequest("GET", "/health"));
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  test("GET /memory returns empty collections", async () => {
    const res = await handler(makeRequest("GET", "/memory"));
    expect(res.status).toBe(200);
    const body = await res.json() as { preferences: unknown[]; facts: unknown[]; learned: unknown[] };
    expect(Array.isArray(body.preferences)).toBe(true);
    expect(Array.isArray(body.facts)).toBe(true);
    expect(Array.isArray(body.learned)).toBe(true);
  });

  test("GET /cron returns empty array", async () => {
    const res = await handler(makeRequest("GET", "/cron"));
    expect(res.status).toBe(200);
    const body = await res.json() as unknown[];
    expect(Array.isArray(body)).toBe(true);
  });

  test("unknown route returns 404", async () => {
    const res = await handler(makeRequest("GET", "/unknown"));
    expect(res.status).toBe(404);
  });
});
