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

// "=" makes tmux match the session name exactly. Without it, tmux falls back
// to a prefix match and could kill a session such as "claude-bot-old".
export function killSessionArgs(): string[] {
  return ["kill-session", "-t", `=${SESSION}`];
}

function killBot(logPath: string): void {
  const result = spawnSync("tmux", killSessionArgs());
  if (result.error) {
    log(logPath, `KILL ERROR: tmux not found or failed: ${result.error.message}`);
  } else if (result.status !== 0) {
    // Non-zero is expected if the session doesn't exist — log at debug level
    const stderr = (result.stderr?.toString() ?? "").trim();
    log(logPath, `KILL: tmux exited ${result.status}${stderr ? `: ${stderr}` : ""}`);
  }
}

// pgrep -f alone matches any user's process; another account could run a
// process with a matching command line. Look only at the owner's processes.
export function botPgrepArgs(uid: number): string[] {
  return ["-u", String(uid), "-f", "claude.*--channels plugin:telegram"];
}

async function waitForBotRestart(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await Bun.sleep(POLL_INTERVAL_MS);
    const result = spawnSync("pgrep", botPgrepArgs(process.getuid!()), { encoding: "utf-8" });
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
      this.attempts = []; // Reset so self-recovery is possible after backoff expires
      return;
    }

    const attempt = this.attempts.length + 1;
    log(this.healthLogPath, `RECOVERY attempt ${attempt}/${MAX_ATTEMPTS}`);
    this.attempts.push({ time: Date.now() });

    killBot(this.healthLogPath);
    const recovered = await waitForBotRestart(RECOVERY_TIMEOUT_MS);
    if (recovered) {
      log(this.healthLogPath, "RECOVERED");
      await this.telegram.sendMessageWithRetry("⚠️ Bot was hung and has been restarted").catch(() => {});
    } else {
      log(this.healthLogPath, "RECOVERY FAILED — bot did not restart within 90s");
    }
  }
}
