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

    if (exitCode !== 0) {
      throw new Error(`[executor] claude exited ${exitCode}: ${stderr.slice(0, 500)}`);
    }

    const output = stdout.slice(0, MAX_OUTPUT);
    await telegram.sendMessageWithRetry(output || "(no output)");
  } catch (e: unknown) {
    if (controller.signal.aborted) {
      proc.kill();
      throw new Error(`[executor] claude timed out after ${TIMEOUT_MS / 1000}s`);
    }
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}
