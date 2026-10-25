import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "fs";
import { makeTestDir } from "../test-tmp";
import { join } from "path";
import { agentArgv, agentEnv, executeJob, runProcess, type ExecutorOptions } from "./executor";
import type { CronJob } from "./registry";

let tmpDir: string;
let opts: ExecutorOptions;

function job(fields: Partial<CronJob>): CronJob {
  return {
    id: "job", schedule: "0 9 * * 1", type: "reminder", delivery: "telegram",
    enabled: true, created: "2026-10-25T00:00:00.000Z", lastRun: null, runCount: 0,
    ...fields,
  } as CronJob;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

beforeAll(() => {
  tmpDir = realpathSync(makeTestDir("cron-executor-test-"));
  const agentCwd = join(tmpDir, "agent-cwd");
  mkdirSync(agentCwd, { mode: 0o700 });
  // A stand-in for the claude CLI: prints its working directory, the API key
  // it received, and its arguments.
  const fakeClaude = join(tmpDir, "fake-claude");
  writeFileSync(fakeClaude, "#!/bin/sh\npwd\necho \"KEY:$ANTHROPIC_API_KEY\"\nfor a in \"$@\"; do echo \"ARG:$a\"; done\n");
  chmodSync(fakeClaude, 0o755);
  failingClaude = join(tmpDir, "failing-claude");
  writeFileSync(failingClaude, "#!/bin/sh\necho partial\necho 'model overloaded' >&2\nexit 1\n");
  chmodSync(failingClaude, 0o755);
  opts = { apiKey: "test-key", claudePath: fakeClaude, agentCwd };
});

let failingClaude: string;

// Polls instead of checking once: a killed process can take a moment to be
// reaped, especially on a loaded CI runner.
async function waitUntilDead(pid: number, ms = 3000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await Bun.sleep(25);
  }
  return !isAlive(pid);
}

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("agentArgv", () => {
  const argv = agentArgv(job({ type: "agent", prompt: "--help me" }), "/abs/claude");

  test("never skips permissions", () => {
    expect(argv).not.toContain("--dangerously-skip-permissions");
  });

  test("runs in restricted print mode with no MCP servers and no permission prompts", () => {
    expect(argv.slice(0, 2)).toEqual(["/abs/claude", "--print"]);
    expect(argv).toContain("--restricted");
    expect(argv).toContain("--strict-mcp-config");
    expect(argv[argv.indexOf("--permission-prompts") + 1]).toBe("none");
  });

  test("allows only WebFetch and WebSearch by default", () => {
    expect(argv[argv.indexOf("--tools") + 1]).toBe("WebFetch,WebSearch");
    expect(argv[argv.indexOf("--allowedTools") + 1]).toBe("WebFetch,WebSearch");
  });

  test("adds tools that the job lists", () => {
    const withTools = agentArgv(job({ type: "agent", prompt: "x", tools: ["Read"] }), "/abs/claude");
    expect(withTools[withTools.indexOf("--tools") + 1]).toBe("WebFetch,WebSearch,Read");
  });

  test("passes the prompt after --, so a prompt starting with - is not read as an option", () => {
    expect(argv.slice(-2)).toEqual(["--", "--help me"]);
  });

  test("rejects a tool name containing a comma", () => {
    expect(() => agentArgv(job({ type: "agent", prompt: "x", tools: ["Read,Bash"] }), "/abs/claude")).toThrow();
  });
});

describe("executeJob", () => {
  test("a reminder returns its message for delivery", async () => {
    expect(await executeJob(job({ type: "reminder", message: "Standup" }), opts)).toBe("Standup");
  });

  test("an agent job runs the claude CLI in the agent directory with the API key", async () => {
    const output = await executeJob(job({ type: "agent", prompt: "hello" }), opts);
    const lines = output!.trim().split("\n");
    expect(lines[0]).toBe(opts.agentCwd);
    expect(lines[1]).toBe("KEY:test-key");
    expect(lines).toContain("ARG:--restricted");
    expect(lines.at(-1)).toBe("ARG:hello");
  });

  test("an agent job gets the API key but not the engine's other secrets", () => {
    const saved = process.env.TELEGRAM_BOT_TOKEN;
    process.env.TELEGRAM_BOT_TOKEN = "telegram-secret";
    try {
      const env = agentEnv("test-key");
      expect(env.ANTHROPIC_API_KEY).toBe("test-key");
      expect(env.TELEGRAM_BOT_TOKEN).toBeUndefined();
      expect(env.HOME).toBe(process.env.HOME);
      expect(env.PATH).toBe(process.env.PATH);
    } finally {
      if (saved === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
      else process.env.TELEGRAM_BOT_TOKEN = saved;
    }
  });

  test("a failing agent run throws instead of delivering its partial output", async () => {
    const failing = { ...opts, claudePath: failingClaude };
    await expect(executeJob(job({ type: "agent", prompt: "x" }), failing)).rejects.toThrow(/claude exited 1: model overloaded/);
  });

  test("a shell job returns nothing to deliver", async () => {
    expect(await executeJob(job({ type: "shell", command: ["/bin/echo", "ok"] }), opts)).toBeNull();
  });

  test("a failing shell job throws with its exit code", async () => {
    await expect(executeJob(job({ type: "shell", command: ["/bin/sh", "-c", "exit 3"] }), opts)).rejects.toThrow(/exited 3/);
  });

  test("an unknown job type throws instead of running an agent", async () => {
    await expect(executeJob(job({ type: "script" as CronJob["type"], prompt: "x" }), opts)).rejects.toThrow(/unknown job type/);
  });
});

describe("runProcess", () => {
  test("returns output and exit code", async () => {
    const result = await runProcess(["/bin/sh", "-c", "echo out; echo err >&2; exit 2"], { timeoutMs: 5000 });
    expect(result).toMatchObject({ exitCode: 2, timedOut: false });
    expect(result.stdout).toBe("out\n");
    expect(result.stderr).toBe("err\n");
  });

  test("on timeout, kills the whole process group, including grandchildren", async () => {
    const result = await runProcess(
      ["/bin/sh", "-c", "sleep 30 & echo \"PID:$!\"; wait"],
      { timeoutMs: 1000, graceMs: 200, drainMs: 200 },
    );
    expect(result.timedOut).toBe(true);
    const match = result.stdout.match(/PID:(\d+)/);
    expect(match).not.toBeNull();
    expect(await waitUntilDead(parseInt(match![1], 10))).toBe(true);
  });

  test("a child that ignores SIGTERM is killed with SIGKILL after the grace period", async () => {
    const started = Date.now();
    const result = await runProcess(
      ["/bin/sh", "-c", "trap '' TERM; echo ready; while true; do sleep 0.05; done"],
      { timeoutMs: 300, graceMs: 200, drainMs: 200 },
    );
    expect(result.timedOut).toBe(true);
    expect(result.stdout).toContain("ready");
    expect(Date.now() - started).toBeLessThan(3000);
  });

  test("a descendant that ignores SIGTERM and closed its pipes is still killed", async () => {
    const started = Date.now();
    const result = await runProcess(
      ["/bin/sh", "-c", "(trap '' TERM; exec sleep 30) >/dev/null 2>&1 & echo \"PID:$!\"; sleep 30"],
      { timeoutMs: 300, graceMs: 5000, drainMs: 200 },
    );
    expect(result.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(3000);
    const match = result.stdout.match(/PID:(\d+)/);
    expect(await waitUntilDead(parseInt(match![1], 10))).toBe(true);
  });

  test("settles after the main process exits even if a child keeps the pipes open", async () => {
    const started = Date.now();
    const result = await runProcess(
      ["/bin/sh", "-c", "sleep 30 & echo \"PID:$!\"; exit 0"],
      { timeoutMs: 20000, drainMs: 200 },
    );
    expect(Date.now() - started).toBeLessThan(5000);
    expect(result).toMatchObject({ exitCode: 0, timedOut: false });
    const match = result.stdout.match(/PID:(\d+)/);
    expect(await waitUntilDead(parseInt(match![1], 10))).toBe(true);
  });

  test("keeps multi-byte characters intact across output chunks", async () => {
    const result = await runProcess(["/bin/sh", "-c", "printf '\\360\\237\\216\\211%.0s' $(seq 1 3000)"], { timeoutMs: 5000 });
    expect(result.stdout).toBe("🎉".repeat(3000));
  });

  test("rejects when the program does not exist", async () => {
    await expect(runProcess([join(tmpDir, "no-such-binary")], { timeoutMs: 1000 })).rejects.toThrow();
  });
});
