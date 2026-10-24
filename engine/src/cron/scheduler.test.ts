import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { CronRegistry, type CronJob } from "./registry";
import { CronScheduler } from "./scheduler";
import type { TelegramClient } from "../telegram";

let tmpDir: string;
let registry: CronRegistry;
let sent: string[];
let failSends: number;
let executed: string[];
let executeImpl: (job: CronJob) => Promise<string | null>;
let scheduler: CronScheduler;

const telegram = {
  async sendMessageWithRetry(text: string): Promise<void> {
    if (failSends > 0) {
      failSends--;
      throw new Error("[telegram] sendMessage failed: 502");
    }
    sent.push(text);
  },
} as unknown as TelegramClient;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "cron-scheduler-test-"));
  registry = new CronRegistry(join(tmpDir, "cron-jobs.json"));
  sent = [];
  failSends = 0;
  executed = [];
  executeImpl = async (job) => (job.type === "reminder" ? job.message! : "agent output");
  scheduler = new CronScheduler(registry, telegram, {
    apiKey: "test-key",
    claudePath: "/unused",
    agentCwd: tmpDir,
    deliveryRetryDelayMs: 10,
    execute: async (job) => {
      executed.push(job.id);
      return executeImpl(job);
    },
  });
});

afterEach(() => {
  registry.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

function addReminder(id: string, message = "hi"): void {
  registry.create({ id, schedule: "0 9 * * 1", type: "reminder", message, delivery: "telegram" });
}

describe("CronScheduler runs the job as stored now", () => {
  test("uses the current message, not the one captured when scheduled", async () => {
    addReminder("r", "old text");
    registry.update("r", { message: "new text" });
    scheduler.runNow("r");
    await scheduler.idle();
    expect(sent).toEqual(["new text"]);
  });

  test("a scheduled run skips a job that was disabled after scheduling", async () => {
    addReminder("r");
    registry.update("r", { enabled: false });
    await scheduler.runScheduled("r");
    expect(executed).toEqual([]);
  });

  test("a scheduled run skips a job that was deleted after scheduling", async () => {
    addReminder("r");
    registry.remove("r");
    await scheduler.runScheduled("r");
    expect(executed).toEqual([]);
  });

  test("run now still runs a disabled job", async () => {
    addReminder("r");
    registry.update("r", { enabled: false });
    scheduler.runNow("r");
    await scheduler.idle();
    expect(executed).toEqual(["r"]);
  });

  test("run now throws for an unknown job", () => {
    expect(() => scheduler.runNow("nope")).toThrow(/job not found/);
  });

  test("runCount counts every run from the stored value", async () => {
    addReminder("r");
    for (let i = 0; i < 3; i++) scheduler.runNow("r");
    await scheduler.idle();
    expect(registry.get("r")?.runCount).toBe(3);
    expect(registry.get("r")?.lastRun).not.toBeNull();
  });
});

describe("CronScheduler failures", () => {
  test("a failed execution is recorded and reported, and the job is not run again", async () => {
    addReminder("r");
    executeImpl = async () => {
      throw new Error("[executor] claude exited 1: boom");
    };
    scheduler.runNow("r");
    await scheduler.idle();
    expect(executed).toEqual(["r"]);
    expect(registry.get("r")?.lastError).toContain("exited 1");
    expect(registry.get("r")?.runCount).toBe(0);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('Cron job "r" failed');
  });

  test("a failed delivery retries only the delivery, never the execution", async () => {
    addReminder("r", "deliver me");
    failSends = 1;
    scheduler.runNow("r");
    await scheduler.idle();
    expect(executed).toEqual(["r"]);
    expect(sent).toEqual(["deliver me"]);
    expect(registry.get("r")?.runCount).toBe(1);
    expect(registry.get("r")?.lastError).toBeUndefined();
  });

  test("a delivery that fails twice is recorded on the job", async () => {
    addReminder("r", "deliver me");
    failSends = 2;
    scheduler.runNow("r");
    await scheduler.idle();
    expect(executed).toEqual(["r"]);
    expect(sent).toEqual([]);
    expect(registry.get("r")?.runCount).toBe(1);
    expect(registry.get("r")?.lastError).toContain("delivery failed");
  });

  test("a shell job's null output sends nothing", async () => {
    registry.create({ id: "s", schedule: "0 9 * * 1", type: "shell", command: ["/bin/true"], delivery: "telegram" });
    executeImpl = async () => null;
    scheduler.runNow("s");
    await scheduler.idle();
    expect(sent).toEqual([]);
    expect(registry.get("s")?.runCount).toBe(1);
  });
});
