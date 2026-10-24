import { spawn } from "child_process";
import type { CronJob } from "./registry";

const TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const KILL_GRACE_MS = 5000;
const DRAIN_MS = 2000;
const MAX_OUTPUT = 3800;
// Per stream, in characters. Capture stops after the chunk that reaches this
// size, so the kept output can exceed it by one chunk.
const MAX_CAPTURE = 1024 * 1024;

// Agent jobs read untrusted web content, so by default they get only these
// tools. A job can add more through its `tools` field, which only a hand
// edit of cron-jobs.json can set.
export const DEFAULT_AGENT_TOOLS = ["WebFetch", "WebSearch"];

export interface ExecutorOptions {
  apiKey: string;
  claudePath: string; // absolute path to the claude CLI
  agentCwd: string;   // owner-only working directory for agent jobs
  timeoutMs?: number;
}

export interface ProcessResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  graceMs?: number;
  drainMs?: number;
}

// Runs argv in its own process group without a shell, and always settles.
//  - On timeout it sends SIGTERM to the group, then SIGKILL after a grace
//    period, or as soon as the run settles if that comes first.
//    Descendants that left the group (setsid) are not reached.
//  - It settles when the output pipes close. If something still holds them
//    open, it settles anyway: DRAIN_MS after the main process exits (and
//    then kills what is left of the group), or DRAIN_MS after the SIGKILL.
export function runProcess(argv: string[], opts: RunOptions): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const drainMs = opts.drainMs ?? DRAIN_MS;
    const child = spawn(argv[0], argv.slice(1), {
      cwd: opts.cwd,
      env: opts.env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let exitCode: number | null = null;
    let settled = false;
    const timers: ReturnType<typeof setTimeout>[] = [];
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d: string) => { if (stdout.length < MAX_CAPTURE) stdout += d; });
    child.stderr.on("data", (d: string) => { if (stderr.length < MAX_CAPTURE) stderr += d; });

    const killGroup = (signal: NodeJS.Signals): void => {
      try {
        process.kill(-child.pid!, signal);
      } catch (e) {
        // ESRCH: the group is already gone. Anything else is worth a log.
        if ((e as NodeJS.ErrnoException).code !== "ESRCH") {
          console.error(`[executor] Failed to signal process group: ${(e as Error).message}. Context: pid=${child.pid} signal=${signal}`);
        }
      }
    };
    const finish = (): void => {
      if (settled) return;
      settled = true;
      timers.forEach(clearTimeout);
      // Once a timeout has started, end with SIGKILL even if the pipes
      // closed first: a descendant can ignore SIGTERM after redirecting its
      // output away from the pipes.
      if (timedOut) killGroup("SIGKILL");
      child.stdout.destroy();
      child.stderr.destroy();
      resolve({ exitCode, stdout, stderr, timedOut });
    };

    timers.push(setTimeout(() => {
      timedOut = true;
      killGroup("SIGTERM");
      timers.push(setTimeout(() => {
        killGroup("SIGKILL");
        timers.push(setTimeout(finish, drainMs));
      }, opts.graceMs ?? KILL_GRACE_MS));
    }, opts.timeoutMs));

    child.on("error", (e) => {
      if (settled) return;
      settled = true;
      timers.forEach(clearTimeout);
      reject(new Error(`[executor] Failed to start ${argv[0]}: ${e.message}`));
    });
    child.on("exit", (code) => {
      exitCode = code;
      if (settled) return;
      // Pipes still open after the leader exits mean descendants remain.
      // Those still in the group are killed. If all of them left the group,
      // its id is free and the kill normally finds nothing; only if the
      // system reused that id within drainMs could it reach another group.
      timers.push(setTimeout(() => {
        killGroup("SIGKILL");
        finish();
      }, drainMs));
    });
    child.on("close", finish);
  });
}

export function agentArgv(job: CronJob, claudePath: string): string[] {
  const extra = job.tools ?? [];
  for (const tool of extra) {
    if (typeof tool !== "string" || tool.length === 0 || tool.includes(",")) {
      throw new Error(`[executor] Invalid tool name in job ${job.id}: ${JSON.stringify(tool)}`);
    }
  }
  const tools = [...DEFAULT_AGENT_TOOLS, ...extra].join(",");
  return [
    claudePath, "--print",
    "--restricted", "--strict-mcp-config",
    "--permission-prompts", "none",
    "--tools", tools,
    "--allowedTools", tools,
    "--", job.prompt!,
  ];
}

// Agent jobs get only what the claude CLI needs to run, plus the API key.
// The engine's other variables, such as a Telegram bot token, stay out.
const AGENT_ENV_VARS = ["HOME", "PATH", "TMPDIR", "USER", "LOGNAME", "LANG", "LC_ALL", "TERM"];

export function agentEnv(apiKey: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ANTHROPIC_API_KEY: apiKey };
  for (const name of AGENT_ENV_VARS) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  return env;
}

function failure(what: string, result: ProcessResult, timeoutMs: number): Error {
  if (result.timedOut) return new Error(`[executor] ${what} timed out after ${timeoutMs / 1000}s`);
  return new Error(`[executor] ${what} exited ${result.exitCode}: ${result.stderr.slice(0, 500)}`);
}

// Runs the job and returns the text to deliver, or null when there is
// nothing to send (shell jobs send their own messages).
export async function executeJob(job: CronJob, opts: ExecutorOptions): Promise<string | null> {
  const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;

  if (job.type === "reminder") return job.message!;

  if (job.type === "shell") {
    const result = await runProcess(job.command!, { env: { ...process.env }, timeoutMs });
    if (result.timedOut || result.exitCode !== 0) throw failure("shell job", result, timeoutMs);
    return null;
  }

  if (job.type === "agent") {
    const result = await runProcess(agentArgv(job, opts.claudePath), {
      cwd: opts.agentCwd,
      env: agentEnv(opts.apiKey),
      timeoutMs,
    });
    if (result.timedOut || result.exitCode !== 0) throw failure("claude", result, timeoutMs);
    return result.stdout.slice(0, MAX_OUTPUT);
  }

  throw new Error(`[executor] unknown job type: ${JSON.stringify(job.type)}. Context: id=${job.id}`);
}
