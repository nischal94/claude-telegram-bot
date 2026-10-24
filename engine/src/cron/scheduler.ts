import cron from "node-cron";
import { RegistryConflictError, type CronRegistry, type CronJob, type JobPatch } from "./registry";
import { executeJob, type ExecutorOptions } from "./executor";
import type { TelegramClient } from "../telegram";

const DELIVERY_RETRY_DELAY_MS = 60_000;

export interface SchedulerOptions extends ExecutorOptions {
  deliveryRetryDelayMs?: number;
  execute?: (job: CronJob, opts: ExecutorOptions) => Promise<string | null>;
}

// Identifies the job a run was queued for. A job deleted and recreated with
// the same id gets a new `created` value, so a run queued for the old job
// never runs or updates the new one. A scheduled run also carries the
// schedule that fired it, and is dropped if the schedule changed since.
interface RunTarget {
  id: string;
  created: string;
  schedule?: string;
  manual: boolean;
}

function instanceKey(target: RunTarget): string {
  return `${target.id}@${target.created}`;
}

export class CronScheduler {
  private registry: CronRegistry;
  private telegram: TelegramClient;
  private options: SchedulerOptions;
  private execute: NonNullable<SchedulerOptions["execute"]>;
  private tasks: Map<string, { task: ReturnType<typeof cron.schedule>; schedule: string; created: string }> = new Map();
  private pendingRetries: Set<Promise<void>> = new Set();

  constructor(registry: CronRegistry, telegram: TelegramClient, options: SchedulerOptions) {
    this.registry = registry;
    this.telegram = telegram;
    this.options = options;
    this.execute = options.execute ?? executeJob;
  }

  start(): void {
    this.stopped = false;
    this.sync();
    // Re-sync every minute to pick up registry changes
    this.syncTask = cron.schedule("* * * * *", () => this.sync());
  }

  private syncTask: ReturnType<typeof cron.schedule> | null = null;
  private stopped = false;

  // Queues a manual run. A manual run also runs a disabled job. A job that
  // is already queued or running is not queued again.
  runNow(jobId: string): void {
    const job = this.registry.get(jobId);
    if (!job) throw new Error(`job not found: ${jobId}`);
    void this.enqueue({ id: jobId, created: job.created, manual: true });
  }

  // Queues a scheduled run of the job as it is now. The run is skipped if,
  // by the time it starts, the job is disabled, deleted, replaced, or has a
  // different schedule.
  runScheduled(jobId: string): Promise<void> {
    const job = this.registry.get(jobId);
    if (!job) return this.executionQueue;
    return this.enqueue({ id: jobId, created: job.created, schedule: job.schedule, manual: false });
  }

  // Resolves once every queued run and pending delivery retry has finished.
  async idle(): Promise<void> {
    await this.executionQueue;
    await Promise.all([...this.pendingRetries]);
  }

  // Which instance of a job its timer was set up for, for diagnostics and
  // tests; undefined when the job has no timer.
  scheduledInstance(jobId: string): string | undefined {
    return this.tasks.get(jobId)?.created;
  }

  // Stops every timer, including the per-minute sync, so nothing fires or
  // re-creates timers until start() is called again.
  stop(): void {
    this.stopped = true;
    this.syncTask?.stop();
    this.syncTask = null;
    for (const { task } of this.tasks.values()) task.stop();
    this.tasks.clear();
  }

  // Matches timers to the registry: called at start and every minute.
  sync(): void {
    if (this.stopped) return;
    const jobs = this.registry.list();
    const currentIds = new Set(jobs.map((j) => j.id));

    // Remove tasks for deleted/disabled jobs, jobs whose schedule changed,
    // and jobs deleted and recreated with the same id since the last sync.
    for (const [id, { task, schedule, created }] of this.tasks) {
      const job = this.registry.get(id);
      if (!currentIds.has(id) || !job?.enabled || job.schedule !== schedule || job.created !== created) {
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
      const target: RunTarget = { id: job.id, created: job.created, schedule: job.schedule, manual: false };
      const task = cron.schedule(job.schedule, () => { void this.enqueue(target); });
      this.tasks.set(job.id, { task, schedule: job.schedule, created: job.created });
    }
  }

  // Serialize job execution — one job at a time to avoid hammering Claude API
  private executionQueue: Promise<void> = Promise.resolve();
  // Job instances that are queued or running, keyed by id and created. An
  // instance runs at most once at a time, so a run longer than its interval
  // cannot build up a backlog, while a recreated job is not blocked by a
  // run still queued for the old one.
  private pending: Set<string> = new Set();
  // Runs started per job instance, failed ones included. A delayed delivery
  // retry records its error only if no later run has started.
  private attempts: Map<string, number> = new Map();

  private enqueue(target: RunTarget): Promise<void> {
    const key = instanceKey(target);
    if (this.pending.has(key)) {
      console.log(`[scheduler] skipping job ${target.id}: already queued or running`);
      return this.executionQueue;
    }
    this.pending.add(key);
    this.executionQueue = this.executionQueue
      .then(() => this.doRun(target))
      .catch((e: unknown) => {
        // doRun handles its own failures; this keeps one unexpected error
        // from stopping every later run in the chain.
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[scheduler] Unexpected error in job run: ${msg}. Context: id=${target.id}`);
      })
      .finally(() => this.pending.delete(key));
    return this.executionQueue;
  }

  // The job as stored now, if it is still the one the run was queued for.
  private current(target: RunTarget): CronJob | undefined {
    const job = this.registry.get(target.id);
    return job && job.created === target.created ? job : undefined;
  }

  // Records run state on the job the run belongs to. The job may have been
  // deleted or replaced, or the registry may refuse saves after a bad load;
  // none of these should stop the run. A save refused because the file
  // changed on disk is tried once more after the reload.
  private record(target: RunTarget, patch: (job: CronJob) => JobPatch): void {
    for (let attempt = 0; attempt < 2; attempt++) {
      const job = this.current(target);
      if (!job) return;
      try {
        this.registry.update(target.id, patch(job));
        return;
      } catch (e: unknown) {
        if (e instanceof RegistryConflictError && attempt === 0) continue;
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[scheduler] Failed to record run state: ${msg}. Context: id=${target.id}`);
        return;
      }
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

  // Always reads the job from the registry at run time, so pauses, deletions
  // and message or prompt edits made after queueing apply to the run.
  private async doRun(target: RunTarget): Promise<void> {
    const job = this.current(target);
    const skip = !job ? "deleted or replaced"
      : !target.manual && !job.enabled ? "disabled"
      : target.schedule !== undefined && job.schedule !== target.schedule ? "schedule changed"
      : null;
    if (!job || skip) {
      console.log(`[scheduler] skipping job ${target.id}: ${skip}`);
      return;
    }
    console.log(`[scheduler] running job ${target.id}`);
    const key = instanceKey(target);
    const attempt = (this.attempts.get(key) ?? 0) + 1;
    this.attempts.set(key, attempt);

    let output: string | null;
    try {
      output = await this.execute(job, this.options);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[scheduler] job ${target.id} failed: ${msg}`);
      this.record(target, () => ({ lastError: msg }));
      // Not retried: an agent or shell job may already have acted. The job
      // runs again at its next scheduled time.
      await this.notify(`❌ Cron job "${target.id}" failed: ${msg}`);
      return;
    }

    const runStamp = new Date().toISOString();
    this.record(target, (current) => ({
      lastRun: runStamp,
      runCount: current.runCount + 1,
      lastError: undefined,
    }));
    if (output === null) return;

    const text = output || "(no output)";
    try {
      await this.telegram.sendMessageWithRetry(text);
    } catch (e: unknown) {
      const delayMs = this.options.deliveryRetryDelayMs ?? DELIVERY_RETRY_DELAY_MS;
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[scheduler] job ${target.id} delivery failed, sending again in ${delayMs / 1000}s: ${msg}`);
      // Send again once later, outside the queue; never re-run the job.
      const retry = (async () => {
        await Bun.sleep(delayMs);
        if (!this.current(target)) {
          console.log(`[scheduler] dropping delivery retry for job ${target.id}: deleted or replaced`);
          return;
        }
        try {
          await this.telegram.sendMessageWithRetry(text);
        } catch (e2: unknown) {
          const msg2 = e2 instanceof Error ? e2.message : String(e2);
          console.error(`[scheduler] job ${target.id} delivery failed twice: ${msg2}`);
          // Only this run's record: a newer run's status must stand.
          const stillLatestRun = this.attempts.get(key) === attempt;
          if (stillLatestRun) this.record(target, () => ({ lastError: `delivery failed: ${msg2}` }));
        }
      })();
      this.pendingRetries.add(retry);
      void retry.finally(() => this.pendingRetries.delete(retry));
    }
  }
}
