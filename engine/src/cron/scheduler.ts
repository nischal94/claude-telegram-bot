import cron from "node-cron";
import type { CronRegistry, CronJob } from "./registry";
import { executeJob, type ExecutorOptions } from "./executor";
import type { TelegramClient } from "../telegram";

const DELIVERY_RETRY_DELAY_MS = 60_000;

export interface SchedulerOptions extends ExecutorOptions {
  deliveryRetryDelayMs?: number;
  execute?: (job: CronJob, opts: ExecutorOptions) => Promise<string | null>;
}

export class CronScheduler {
  private registry: CronRegistry;
  private telegram: TelegramClient;
  private options: SchedulerOptions;
  private execute: NonNullable<SchedulerOptions["execute"]>;
  private tasks: Map<string, { task: ReturnType<typeof cron.schedule>; schedule: string }> = new Map();
  private pendingRetries: Set<Promise<void>> = new Set();

  constructor(registry: CronRegistry, telegram: TelegramClient, options: SchedulerOptions) {
    this.registry = registry;
    this.telegram = telegram;
    this.options = options;
    this.execute = options.execute ?? executeJob;
  }

  start(): void {
    this.sync();
    // Re-sync every minute to pick up registry changes
    cron.schedule("* * * * *", () => this.sync());
  }

  // Queues a manual run. A manual run also runs a disabled job.
  runNow(jobId: string): void {
    if (!this.registry.get(jobId)) throw new Error(`job not found: ${jobId}`);
    void this.enqueue(jobId, true);
  }

  // Queues a scheduled run, which skips the job if it is now disabled or gone.
  runScheduled(jobId: string): Promise<void> {
    return this.enqueue(jobId, false);
  }

  // Resolves once every queued run and pending delivery retry has finished.
  async idle(): Promise<void> {
    await this.executionQueue;
    await Promise.all([...this.pendingRetries]);
  }

  private sync(): void {
    const jobs = this.registry.list();
    const currentIds = new Set(jobs.map((j) => j.id));

    // Remove tasks for deleted/disabled jobs, or jobs whose schedule changed
    for (const [id, { task, schedule }] of this.tasks) {
      const job = this.registry.get(id);
      if (!currentIds.has(id) || !job?.enabled || job.schedule !== schedule) {
        task.stop();
        this.tasks.delete(id);
      }
    }

    // Add tasks for new enabled jobs (or re-add after schedule change)
    for (const job of jobs) {
      if (!job.enabled || this.tasks.has(job.id)) continue;
      if (!cron.validate(job.schedule)) {
        console.error(`[scheduler] invalid cron expression for job ${job.id}: ${job.schedule}`);
        continue;
      }
      const id = job.id;
      const task = cron.schedule(job.schedule, () => { void this.runScheduled(id); });
      this.tasks.set(id, { task, schedule: job.schedule });
    }
  }

  // Serialize job execution — one job at a time to avoid hammering Claude API
  private executionQueue: Promise<void> = Promise.resolve();

  private enqueue(jobId: string, manual: boolean): Promise<void> {
    this.executionQueue = this.executionQueue.then(() => this.doRun(jobId, manual));
    return this.executionQueue;
  }

  // Records run state on the job. The job may have been deleted, or the
  // registry may refuse saves after a bad load; neither should stop the run.
  private record(jobId: string, patch: Partial<CronJob>): void {
    try {
      this.registry.update(jobId, patch);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[scheduler] Failed to record run state: ${msg}. Context: id=${jobId}`);
    }
  }

  private async notify(text: string): Promise<void> {
    try {
      await this.telegram.sendMessageWithRetry(text);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[scheduler] Failed to send failure notice: ${msg}`);
    }
  }

  // Always reads the job from the registry at run time, so edits, pauses and
  // deletions made after the job was scheduled take effect.
  private async doRun(jobId: string, manual: boolean): Promise<void> {
    const job = this.registry.get(jobId);
    if (!job || (!job.enabled && !manual)) {
      console.log(`[scheduler] skipping job ${jobId}: ${job ? "disabled" : "deleted"}`);
      return;
    }
    console.log(`[scheduler] running job ${jobId}`);

    let output: string | null;
    try {
      output = await this.execute(job, this.options);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[scheduler] job ${jobId} failed: ${msg}`);
      this.record(jobId, { lastError: msg });
      // No automatic re-run: an agent or shell job may already have acted.
      await this.notify(`❌ Cron job "${jobId}" failed: ${msg}`);
      return;
    }

    this.record(jobId, {
      lastRun: new Date().toISOString(),
      runCount: (this.registry.get(jobId)?.runCount ?? job.runCount ?? 0) + 1,
      lastError: undefined,
    });
    if (output === null) return;

    const text = output || "(no output)";
    try {
      await this.telegram.sendMessageWithRetry(text);
    } catch {
      // Retry the delivery once later, outside the queue; never re-run the job.
      const retry = (async () => {
        await Bun.sleep(this.options.deliveryRetryDelayMs ?? DELIVERY_RETRY_DELAY_MS);
        try {
          await this.telegram.sendMessageWithRetry(text);
        } catch (e2: unknown) {
          const msg = e2 instanceof Error ? e2.message : String(e2);
          console.error(`[scheduler] job ${jobId} delivery failed twice: ${msg}`);
          this.record(jobId, { lastError: `delivery failed: ${msg}` });
        }
      })();
      this.pendingRetries.add(retry);
      void retry.finally(() => this.pendingRetries.delete(retry));
    }
  }
}
