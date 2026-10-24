import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { agentArgv, executeJob, runProcess, type ExecutorOptions } from "./executor";
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
  tmpDir = realpathSync(mkdtempSync(join(tmpdir(), "cron-executor-test-")));
  const agentCwd = join(tmpDir, "agent-cwd");
  mkdirSync(agentCwd, { mode: 0o700 });
  // A stand-in for the claude CLI: prints its working directory and arguments.
  const fakeClaude = join(tmpDir, "fake-claude");
  writeFileSync(fakeClaude, "#!/bin/sh\npwd\nfor a in \"$@\"; do echo \"ARG:$a\"; done\n");
  chmodSync(fakeClaude, 0o755);
  opts = { apiKey: "test-key", claudePath: fakeClaude, agentCwd };
});

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

  test("an agent job runs the claude CLI in the empty agent directory", async () => {
    const output = await executeJob(job({ type: "agent", prompt: "hello" }), opts);
    const lines = output!.trim().split("\n");
    expect(lines[0]).toBe(opts.agentCwd);
    expect(lines).toContain("ARG:--restricted");
    expect(lines.at(-1)).toBe("ARG:hello");
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
      ["/bin/sh", "-c", "sleep 30 & echo $!; wait"],
      { timeoutMs: 300, graceMs: 200 },
    );
    expect(result.timedOut).toBe(true);
    const grandchild = parseInt(result.stdout.trim(), 10);
    expect(grandchild).toBeGreaterThan(0);
    expect(isAlive(grandchild)).toBe(false);
  });

  test("rejects when the program does not exist", async () => {
    await expect(runProcess([join(tmpDir, "no-such-binary")], { timeoutMs: 1000 })).rejects.toThrow();
  });
});
