import { spawn } from "child_process";
import type { CronJob } from "./registry";

const TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const KILL_GRACE_MS = 5000;
const MAX_OUTPUT = 3800;
const MAX_CAPTURE = 1024 * 1024; // per stream; more output is dropped

// Agent jobs read untrusted web content, so by default they get only these
// tools. A job can add more through its `tools` field, which only a hand
// edit of cron-jobs.json can set.
export const DEFAULT_AGENT_TOOLS = ["WebFetch", "WebSearch"];

export interface ExecutorOptions {
  apiKey: string;
  claudePath: string; // absolute path to the claude CLI
  agentCwd: string;   // empty, owner-only working directory for agent jobs
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
}

// Runs argv in its own process group without a shell. On timeout it sends
// SIGTERM to the whole group, then SIGKILL after a grace period, so
// grandchildren that hold the output pipes open cannot outlive the job.
export function runProcess(argv: string[], opts: RunOptions): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), {
      cwd: opts.cwd,
      env: opts.env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    child.stdout.on("data", (d: Buffer) => { if (stdout.length < MAX_CAPTURE) stdout += d.toString(); });
    child.stderr.on("data", (d: Buffer) => { if (stderr.length < MAX_CAPTURE) stderr += d.toString(); });

    const killGroup = (signal: NodeJS.Signals): void => {
      try {
        process.kill(-child.pid!, signal);
      } catch {
        // The group is already gone.
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup("SIGTERM");
      graceTimer = setTimeout(() => killGroup("SIGKILL"), opts.graceMs ?? KILL_GRACE_MS);
    }, opts.timeoutMs);

    child.on("error", (e) => {
      clearTimeout(timer);
      clearTimeout(graceTimer);
      reject(new Error(`[executor] Failed to start ${argv[0]}: ${e.message}`));
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      clearTimeout(graceTimer);
      resolve({ exitCode, stdout, stderr, timedOut });
    });
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

function failure(job: CronJob, what: string, result: ProcessResult, timeoutMs: number): Error {
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
    if (result.timedOut || result.exitCode !== 0) throw failure(job, "shell job", result, timeoutMs);
    return null;
  }

  if (job.type === "agent") {
    const result = await runProcess(agentArgv(job, opts.claudePath), {
      cwd: opts.agentCwd,
      env: { ...process.env, ANTHROPIC_API_KEY: opts.apiKey },
      timeoutMs,
    });
    if (result.timedOut || result.exitCode !== 0) throw failure(job, "claude", result, timeoutMs);
    return result.stdout.slice(0, MAX_OUTPUT);
  }

  throw new Error(`[executor] unknown job type: ${JSON.stringify(job.type)}. Context: id=${job.id}`);
}
