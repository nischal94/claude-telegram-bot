import { randomBytes, timingSafeEqual } from "crypto";
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { loadConfig, type Config } from "./config";
import { ensureOwnerOnlyDir, writeOwnerOnly } from "./fsutil";
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

export function generateApiToken(): string {
  return randomBytes(32).toString("hex");
}

// Publishes the token as a ready-made header line for `curl -H @file`, which
// keeps the token out of process arguments. Call this only after the server
// has bound its port, so a launch that fails to bind never replaces a
// running engine's token.
export function publishApiToken(dir: string, token: string): void {
  writeOwnerOnly(join(dir, "api-auth-header"), `Authorization: Bearer ${token}\n`);
}

// Logs the reason and a non-secret detail. The detail may quote the Host or
// Sec-Fetch-Site value, JSON-escaped; it never includes the Authorization
// header or the token.
function reject(status: number, error: string, method: string, path: string, detail: string): Response {
  console.warn(`[engine] Request rejected: ${error}. Context: ${method} ${path} status=${status} ${detail}`);
  return Response.json({ error }, { status });
}

const BEARER_PREFIX = "Bearer ";

function tokenMatches(authorization: string | null, token: string): boolean {
  if (!authorization?.startsWith(BEARER_PREFIX)) return false;
  const given = Buffer.from(authorization.slice(BEARER_PREFIX.length));
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
  if (options.token.length === 0) {
    throw new Error("[engine] buildFetchHandler failed: empty API token. Context: options.token");
  }
  const allowedHosts = new Set([`127.0.0.1:${options.port}`, `localhost:${options.port}`]);

  return async function fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    // Reject anything that looks like a browser or a rebound DNS name. A Host
    // other than 127.0.0.1 or localhost on this port can come from DNS
    // rebinding. An Origin header, or any Sec-Fetch-Site value other than
    // "none", means the request came from a web page.
    if (!allowedHosts.has(url.host)) {
      return reject(403, "host not allowed", method, path, `host=${JSON.stringify(url.host)}`);
    }
    if (req.headers.has("origin")) {
      return reject(403, "browser origin not allowed", method, path, "origin=present");
    }
    const fetchSite = req.headers.get("sec-fetch-site");
    if (fetchSite !== null && fetchSite !== "none") {
      return reject(403, "browser origin not allowed", method, path, `sec-fetch-site=${JSON.stringify(fetchSite)}`);
    }

    // Health check needs no token and returns no data
    if (path === "/health" && method === "GET") return Response.json({ ok: true });

    const authorization = req.headers.get("authorization");
    if (!tokenMatches(authorization, options.token)) {
      return reject(401, "missing or invalid token", method, path, `auth=${authorization === null ? "absent" : "mismatch"}`);
    }

    const cronPatchMatch = path.match(/^\/cron\/([^/]+)$/);
    const hasJsonBody =
      (method === "POST" && (path === "/memory" || path === "/cron")) ||
      (method === "PATCH" && cronPatchMatch !== null);
    if (hasJsonBody && !isJsonContentType(req.headers.get("content-type"))) {
      return reject(415, "Content-Type must be application/json", method, path, "content-type=not-json");
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

  // Ensure directories exist, owner-only even if they already existed. The
  // engine folder holds memory, jobs and the API token; the logs folder holds
  // logs created before the Umask was set, which keep their old modes.
  ensureOwnerOnlyDir(config.companionDir);
  ensureOwnerOnlyDir(config.logsDir);

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

  // Cron — registry for reminder and agent jobs created at runtime via the
  // HTTP API, plus shell jobs added to cron-jobs.json by hand. The
  // github-trending jobs were migrated to native launchd agents
  // (launchd/com.nischal.github-trending-{weekly,monthly}.plist) to remove
  // dependence on the long-running engine for scheduled digests.
  const telegram = new TelegramClient(config.telegramBotToken, config.telegramChatId);
  const registry = new CronRegistry(join(config.companionDir, "cron-jobs.json"), {
    // While the file fails to load, job changes are refused and runs are not
    // recorded, so tell the owner rather than only logging it.
    onLoadStateChange: (state, reason) => {
      const text = state === "unreadable"
        ? `⚠️ cron-jobs.json failed to load (${reason}). Job changes are refused until it is fixed; jobs keep their last good state.`
        : "✅ cron-jobs.json loads again. Job changes are allowed.";
      telegram.sendMessageWithRetry(text).catch((e: unknown) => {
        console.error(`[engine] Failed to send registry notice: ${e instanceof Error ? e.message : String(e)}`);
      });
    },
  });
  // Agent jobs run in a dedicated owner-only folder outside the engine's
  // checkout, so its project settings and files are out of reach; the
  // --restricted flag (see cron/executor.ts) ignores settings files.
  const agentCwd = join(config.companionDir, "agent-cwd");
  mkdirSync(agentCwd, { recursive: true, mode: 0o700 });
  const scheduler = new CronScheduler(registry, telegram, {
    apiKey: config.anthropicApiKey,
    claudePath: config.claudePath,
    agentCwd,
  });
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
  const apiToken = generateApiToken();
  const fetchHandler = buildFetchHandler(memoryRouter, cronRouter, { token: apiToken, port: config.httpPort });

  const { hostname, port } = serveOptions(config);
  const server = Bun.serve({
    hostname,
    port,
    fetch: fetchHandler,
  });
  try {
    publishApiToken(config.companionDir, apiToken);
  } catch (e) {
    // Without the published token no caller can authenticate, so serving on
    // would only look healthy. Exit and let launchd restart the engine.
    const reason = e instanceof Error ? e.message : String(e);
    console.error(`[engine] Failed to publish API token: ${reason}. Context: dir=${config.companionDir}`);
    server.stop(true);
    process.exit(1);
  }

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
