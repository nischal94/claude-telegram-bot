import { mkdirSync, existsSync, readFileSync, writeFileSync } from "fs";
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

export function buildFetchHandler(
  memoryRouter: ReturnType<typeof createMemoryRouter>,
  cronRouter: ReturnType<typeof createCronRouter>
): (req: Request) => Promise<Response> {
  return async function fetch(req: Request): Promise<Response> {
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
    const cronPatchMatch = path.match(/^\/cron\/([^/]+)$/);
    if (cronPatchMatch && method === "PATCH") return cronRouter.handlePatch(req, cronPatchMatch[1]);
    if (cronPatchMatch && method === "DELETE") return cronRouter.handleDelete(req, cronPatchMatch[1]);
    const cronRunMatch = path.match(/^\/cron\/([^/]+)\/run$/);
    if (cronRunMatch && method === "POST") return cronRouter.handleRun(req, cronRunMatch[1]);

    // Health check
    if (path === "/health" && method === "GET") return Response.json({ ok: true });

    return new Response("Not Found", { status: 404 });
  };
}

export function startCompanion() {
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

  // Watchdog — DISABLED: waitForPong polls getUpdates independently, which
  // races with the Telegram plugin's own poller and causes it to die.
  // Re-enable once a non-polling pong mechanism is available (e.g. webhook).
  const healthLogPath = join(config.logsDir, "companion-health.log");
  const recovery = new RecoveryManager(telegram, healthLogPath);
  const heartbeat = new HeartbeatWatchdog({
    telegram,
    healthLogPath,
    onHung: () => recovery.recover(),
  });
  // heartbeat.start(); // disabled — causes getUpdates conflict

  // HTTP server
  const memoryRouter = createMemoryRouter(store, snapshotPath);
  const cronRouter = createCronRouter(registry, scheduler);
  const fetchHandler = buildFetchHandler(memoryRouter, cronRouter);

  const server = Bun.serve({
    port: config.httpPort,
    fetch: fetchHandler,
  });

  console.log(`[companion] HTTP server listening on port ${config.httpPort}`);

  // Graceful shutdown
  process.on("SIGTERM", () => {
    server.stop();
    registry.close();
    store.close();
    // heartbeat.stop(); // disabled
    process.exit(0);
  });

  return { server, store, registry, heartbeat, fetchHandler };
}

// Auto-start when run directly (not when imported by tests)
if (import.meta.main) {
  startCompanion();
}
