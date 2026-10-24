import { randomBytes, timingSafeEqual } from "crypto";
import { mkdirSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { loadConfig, type Config } from "./config";
import { MemoryStore } from "./memory/store";
import { writeSnapshot } from "./memory/snapshot";
import { createMemoryRouter } from "./memory/handler";
import { CronRegistry } from "./cron/registry";
import { CronScheduler } from "./cron/scheduler";
import { createCronRouter } from "./cron/handler";
import { TelegramClient } from "./telegram";
import { HeartbeatWatchdog } from "./watchdog/heartbeat";
import { RecoveryManager } from "./watchdog/recovery";

export interface FetchHandlerOptions {
  token: string;
  port: number;
}

export function serveOptions(config: Pick<Config, "httpPort">): { hostname: string; port: number } {
  return { hostname: "127.0.0.1", port: config.httpPort };
}

// Writes a fresh API token on every engine start. The temp file is created
// with mode 0600 and renamed into place, so readers never see a partial
// token or a wider mode.
export function ensureApiToken(dir: string): string {
  const token = randomBytes(32).toString("hex");
  const path = join(dir, "api-token");
  const tmpPath = `${path}.tmp`;
  rmSync(tmpPath, { force: true });
  writeFileSync(tmpPath, `${token}\n`, { mode: 0o600, flag: "wx" });
  renameSync(tmpPath, path);
  return token;
}

function reject(status: number, error: string, req: Request): Response {
  console.warn(`[engine] Request rejected: ${error}. Context: ${req.method} ${status}`);
  return Response.json({ error }, { status });
}

function tokenMatches(authorization: string | null, token: string): boolean {
  if (!authorization?.startsWith("Bearer ")) return false;
  const given = Buffer.from(authorization.slice("Bearer ".length));
  const expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

function isJsonContentType(contentType: string | null): boolean {
  return contentType?.split(";")[0].trim().toLowerCase() === "application/json";
}

export function buildFetchHandler(
  memoryRouter: ReturnType<typeof createMemoryRouter>,
  cronRouter: ReturnType<typeof createCronRouter>,
  options: FetchHandlerOptions
): (req: Request) => Promise<Response> {
  const allowedHosts = new Set([`127.0.0.1:${options.port}`, `localhost:${options.port}`]);

  return async function fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    // Only local, non-browser callers: a foreign Host means DNS rebinding,
    // and an Origin or cross-site fetch metadata means a web page.
    if (!allowedHosts.has(url.host)) return reject(403, "host not allowed", req);
    if (req.headers.has("origin")) return reject(403, "browser origin not allowed", req);
    const fetchSite = req.headers.get("sec-fetch-site");
    if (fetchSite !== null && fetchSite !== "none") return reject(403, "browser origin not allowed", req);

    // Health check needs no token and returns no data
    if (path === "/health" && method === "GET") return Response.json({ ok: true });

    if (!tokenMatches(req.headers.get("authorization"), options.token)) return reject(401, "missing or invalid token", req);

    const cronPatchMatch = path.match(/^\/cron\/([^/]+)$/);
    const hasJsonBody =
      (method === "POST" && (path === "/memory" || path === "/cron")) ||
      (method === "PATCH" && cronPatchMatch !== null);
    if (hasJsonBody && !isJsonContentType(req.headers.get("content-type"))) {
      return reject(415, "Content-Type must be application/json", req);
    }

    // Memory routes
    if (path === "/memory" && method === "POST") return memoryRouter.handlePost(req);
    if (path === "/memory" && method === "GET") return memoryRouter.handleGet();
    if (path === "/memory/snapshot" && method === "POST") return memoryRouter.handleSnapshot();

    // Cron routes
    if (path === "/cron" && method === "POST") return cronRouter.handlePost(req);
    if (path === "/cron" && method === "GET") return cronRouter.handleGet();
    if (cronPatchMatch && method === "PATCH") return cronRouter.handlePatch(req, cronPatchMatch[1]);
    if (cronPatchMatch && method === "DELETE") return cronRouter.handleDelete(req, cronPatchMatch[1]);
    const cronRunMatch = path.match(/^\/cron\/([^/]+)\/run$/);
    if (cronRunMatch && method === "POST") return cronRouter.handleRun(req, cronRunMatch[1]);

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
      console.log(`[engine] imported ${entries.length} seed memories`);
    } catch (e) {
      console.error("[engine] failed to import seed:", e);
    }
  }

  const snapshotPath = join(config.companionDir, "memory-snapshot.md");
  writeSnapshot(snapshotPath, store.getAll());

  // Cron — registry remains for dynamic reminder/agent/shell jobs created
  // at runtime via the HTTP API. The github-trending jobs were migrated to
  // native launchd agents (launchd/com.nischal.github-trending-{weekly,
  // monthly}.plist) to remove dependence on the long-running engine for
  // scheduled digests.
  const registry = new CronRegistry(join(config.companionDir, "cron-jobs.json"));
  const telegram = new TelegramClient(config.telegramBotToken, config.telegramChatId);
  const scheduler = new CronScheduler(registry, telegram, config.anthropicApiKey);
  scheduler.start();

  // Watchdog — DISABLED: waitForPong polls getUpdates independently, which
  // races with the Telegram plugin's own poller and causes it to die.
  // Re-enable once a non-polling pong mechanism is available (e.g. webhook).
  const healthLogPath = join(config.logsDir, "engine-health.log");
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
  const apiToken = ensureApiToken(config.companionDir);
  const fetchHandler = buildFetchHandler(memoryRouter, cronRouter, { token: apiToken, port: config.httpPort });

  const { hostname, port } = serveOptions(config);
  const server = Bun.serve({
    hostname,
    port,
    fetch: fetchHandler,
  });

  console.log(`[engine] HTTP server listening on ${hostname}:${port}`);

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
