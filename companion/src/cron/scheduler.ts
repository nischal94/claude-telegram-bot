import cron from "node-cron";
import type { CronRegistry, CronJob } from "./registry";
import { executeJob } from "./executor";
import type { TelegramClient } from "../telegram";

export class CronScheduler {
  private registry: CronRegistry;
  private telegram: TelegramClient;
  private apiKey: string;
  private tasks: Map<string, ReturnType<typeof cron.schedule>> = new Map();

  constructor(registry: CronRegistry, telegram: TelegramClient, apiKey: string) {
    this.registry = registry;
    this.telegram = telegram;
    this.apiKey = apiKey;
  }

  start(): void {
    this.sync();
    // Re-sync every minute to pick up registry changes
    cron.schedule("* * * * *", () => this.sync());
  }

  async runNow(jobId: string): Promise<void> {
    const job = this.registry.get(jobId);
    if (!job) throw new Error(`job not found: ${jobId}`);
    await this.run(job);
  }

  private sync(): void {
    const jobs = this.registry.list();
    const currentIds = new Set(jobs.map((j) => j.id));

    // Remove tasks for deleted/disabled jobs
    for (const [id, task] of this.tasks) {
      if (!currentIds.has(id) || !this.registry.get(id)?.enabled) {
        task.stop();
        this.tasks.delete(id);
      }
    }

    // Add tasks for new enabled jobs
    for (const job of jobs) {
      if (!job.enabled || this.tasks.has(job.id)) continue;
      if (!cron.validate(job.schedule)) {
        console.error(`[scheduler] invalid cron expression for job ${job.id}: ${job.schedule}`);
        continue;
      }
      const task = cron.schedule(job.schedule, () => this.run(job));
      this.tasks.set(job.id, task);
    }
  }

  // Serialize job execution — one job at a time to avoid hammering Claude API
  private executionQueue: Promise<void> = Promise.resolve();

  private run(job: CronJob): void {
    this.executionQueue = this.executionQueue.then(() => this.doRun(job));
  }

  private async doRun(job: CronJob): Promise<void> {
    console.log(`[scheduler] running job ${job.id}`);
    try {
      await executeJob(job, this.telegram, this.apiKey);
      this.registry.update(job.id, {
        lastRun: new Date().toISOString(),
        runCount: (job.runCount ?? 0) + 1,
        lastError: undefined,
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[scheduler] job ${job.id} failed: ${msg}`);
      this.registry.update(job.id, { lastError: msg });
      // retry once after 60s
      await Bun.sleep(60_000);
      try {
        await executeJob(job, this.telegram, this.apiKey);
        this.registry.update(job.id, { lastRun: new Date().toISOString(), runCount: (job.runCount ?? 0) + 1, lastError: undefined });
      } catch (e2: unknown) {
        const msg2 = e2 instanceof Error ? e2.message : String(e2);
        await this.telegram.sendMessageWithRetry(`❌ Cron job "${job.id}" failed twice: ${msg2}`).catch(() => {});
      }
    }
  }
}
