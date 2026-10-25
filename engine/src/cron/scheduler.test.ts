import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { makeTestDir } from "../test-tmp";
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

let failWhen: ((text: string) => boolean) | null;
let onFail: (() => void) | null;

const telegram = {
  async sendMessageWithRetry(text: string): Promise<void> {
    if (failSends > 0 || failWhen?.(text)) {
      if (failSends > 0) failSends--;
      onFail?.();
      throw new Error("[telegram] sendMessage failed: 502");
    }
    sent.push(text);
  },
} as unknown as TelegramClient;

beforeEach(() => {
  tmpDir = makeTestDir("cron-scheduler-test-");
  registry = new CronRegistry(join(tmpDir, "cron-jobs.json"));
  sent = [];
  failSends = 0;
  failWhen = null;
  onFail = null;
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
    for (let i = 0; i < 3; i++) {
      scheduler.runNow("r");
      await scheduler.idle();
    }
    expect(registry.get("r")?.runCount).toBe(3);
    expect(registry.get("r")?.lastRun).not.toBeNull();
  });

  test("runCount adds to a value changed on disk since the job was loaded", async () => {
    addReminder("r");
    registry.update("r", { runCount: 41 });
    scheduler.runNow("r");
    await scheduler.idle();
    expect(registry.get("r")?.runCount).toBe(42);
  });

  test("an edit made while the job waits in the queue applies to that run", async () => {
    addReminder("slow", "first");
    addReminder("r", "old text");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    executeImpl = async (job) => {
      if (job.id === "slow") await gate;
      return job.message!;
    };
    scheduler.runNow("slow");
    scheduler.runNow("r");
    registry.update("r", { message: "new text" });
    release();
    await scheduler.idle();
    expect(sent).toEqual(["first", "new text"]);
  });

  test("a job already queued or running is not queued again", async () => {
    addReminder("r");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    executeImpl = async (job) => {
      await gate;
      return job.message!;
    };
    scheduler.runNow("r");
    scheduler.runNow("r");
    void scheduler.runScheduled("r");
    release();
    await scheduler.idle();
    expect(executed).toEqual(["r"]);
  });
});

describe("CronScheduler ties each run to one instance of a job", () => {
  function gated(): { release: () => void } {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    executeImpl = async (job) => {
      if (job.id === "slow") await gate;
      return job.message!;
    };
    return { release };
  }

  test("a run queued for a job that is then deleted and recreated is skipped", async () => {
    addReminder("slow", "first");
    addReminder("r", "old job");
    const { release } = gated();
    scheduler.runNow("slow");
    scheduler.runNow("r");
    registry.remove("r");
    addReminder("r", "new job");
    release();
    await scheduler.idle();
    expect(executed).toEqual(["slow"]);
    expect(registry.get("r")?.runCount).toBe(0);
  });

  test("a scheduled run queued before a schedule change is dropped", async () => {
    addReminder("slow", "first");
    addReminder("r");
    const { release } = gated();
    scheduler.runNow("slow");
    void scheduler.runScheduled("r");
    registry.update("r", { schedule: "30 9 * * 1" });
    release();
    await scheduler.idle();
    expect(executed).toEqual(["slow"]);
  });

  test("sync replaces the timer of a job deleted and recreated with the same id", () => {
    addReminder("r");
    try {
      scheduler.sync();
      const first = scheduler.scheduledInstance("r");
      expect(first).toBe(registry.get("r")!.created);
      registry.remove("r");
      addReminder("r");
      scheduler.sync();
      expect(scheduler.scheduledInstance("r")).toBe(registry.get("r")!.created);
      expect(scheduler.scheduledInstance("r")).not.toBe(first);
    } finally {
      scheduler.stop();
    }
  });

  test("attempt counts of deleted jobs are dropped at the next run", async () => {
    addReminder("gone");
    addReminder("r");
    scheduler.runNow("gone");
    await scheduler.idle();
    registry.remove("gone");
    scheduler.runNow("r");
    await scheduler.idle();
    const keys = [...(scheduler as unknown as { attempts: Map<string, number> }).attempts.keys()];
    expect(keys).toEqual([`r@${registry.get("r")!.created}`]);
  });

  test("after stop, sync no longer creates timers", () => {
    addReminder("r");
    scheduler.start();
    expect(scheduler.scheduledInstance("r")).toBeDefined();
    scheduler.stop();
    expect(scheduler.scheduledInstance("r")).toBeUndefined();
    scheduler.sync();
    expect(scheduler.scheduledInstance("r")).toBeUndefined();
  });

  test("a run still queued for an old job does not block running its replacement", async () => {
    addReminder("slow", "first");
    addReminder("r", "old job");
    const { release } = gated();
    scheduler.runNow("slow");
    scheduler.runNow("r");
    registry.remove("r");
    addReminder("r", "new job");
    scheduler.runNow("r");
    release();
    await scheduler.idle();
    expect(executed).toEqual(["slow", "r"]);
    expect(sent).toEqual(["first", "new job"]);
  });

  test("a late failed retry does not overwrite a newer run's failure", async () => {
    scheduler = new CronScheduler(registry, telegram, {
      apiKey: "test-key",
      claudePath: "/unused",
      agentCwd: tmpDir,
      deliveryRetryDelayMs: 100,
      execute: async (job) => {
        if (job.message === "second run") throw new Error("[executor] claude exited 1: newer failure");
        return job.message!;
      },
    });
    addReminder("r", "first run");
    failWhen = (text) => text === "first run";
    scheduler.runNow("r");
    await Bun.sleep(20);
    registry.update("r", { message: "second run" });
    scheduler.runNow("r");
    await scheduler.idle();
    expect(registry.get("r")?.lastError).toContain("newer failure");
  });

  test("a delivery retry for a job deleted in the meantime is not sent", async () => {
    addReminder("r", "deliver me");
    failSends = 1;
    onFail = () => { registry.remove("r"); };
    scheduler.runNow("r");
    await scheduler.idle();
    expect(sent).toEqual([]);
  });

  test("a late failed retry does not overwrite a newer run's status", async () => {
    scheduler = new CronScheduler(registry, telegram, {
      apiKey: "test-key",
      claudePath: "/unused",
      agentCwd: tmpDir,
      deliveryRetryDelayMs: 100,
      execute: async (job) => job.message!,
    });
    addReminder("r", "first run");
    failWhen = (text) => text === "first run";
    scheduler.runNow("r");
    await Bun.sleep(20);
    registry.update("r", { message: "second run" });
    scheduler.runNow("r");
    await scheduler.idle();
    expect(sent).toEqual(["second run"]);
    expect(registry.get("r")?.runCount).toBe(2);
    expect(registry.get("r")?.lastError).toBeUndefined();
  });
});

describe("CronScheduler keeps running after errors", () => {
  test("a run whose state cannot be saved does not stop later runs", async () => {
    addReminder("a", "one");
    addReminder("b", "two");
    // Make the registry refuse saves: corrupt the file and reload.
    const { writeFileSync } = await import("fs");
    writeFileSync(join(tmpDir, "cron-jobs.json"), "not json");
    registry.reload();
    scheduler.runNow("a");
    scheduler.runNow("b");
    await scheduler.idle();
    expect(sent).toEqual(["one", "two"]);
  });

  test("a run for a job deleted mid-run does not stop later runs", async () => {
    addReminder("a", "one");
    addReminder("b", "two");
    executeImpl = async (job) => {
      if (job.id === "a") registry.remove("a");
      return job.message!;
    };
    scheduler.runNow("a");
    scheduler.runNow("b");
    await scheduler.idle();
    expect(sent).toEqual(["one", "two"]);
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
