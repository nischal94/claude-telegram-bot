import { readFileSync, writeFileSync, mkdirSync, watch } from "fs";
import { dirname } from "path";

export type JobType = "reminder" | "agent" | "shell";

export interface CronJob {
  id: string;
  schedule: string;
  type: JobType;
  message?: string;   // required for reminder
  prompt?: string;    // required for agent
  command?: string[]; // required for shell
  delivery: "telegram";
  enabled: boolean;
  created: string;
  lastRun: string | null;
  runCount: number;
  lastError?: string;
}

export type CreateJobInput = Omit<CronJob, "enabled" | "created" | "lastRun" | "runCount">;

export class CronRegistry {
  private path: string;
  private jobs: Map<string, CronJob> = new Map();
  private watcher: ReturnType<typeof watch> | null = null;

  constructor(registryPath: string) {
    this.path = registryPath;
    mkdirSync(dirname(registryPath), { recursive: true });
    this.load();
    this.watcher = watch(dirname(registryPath), { persistent: false }, (event, filename) => {
      if (filename === "cron-jobs.json") this.load();
    });
  }

  private load(): void {
    try {
      const raw = readFileSync(this.path, "utf-8");
      const arr = JSON.parse(raw) as CronJob[];
      this.jobs = new Map(arr.map((j) => [j.id, j]));
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        console.error(`[registry] Failed to load ${this.path}: ${(err as Error).message}`);
      }
      this.jobs = new Map();
    }
  }

  private save(): void {
    writeFileSync(this.path, JSON.stringify([...this.jobs.values()], null, 2), "utf-8");
  }

  create(input: CreateJobInput): string {
    let id = input.id;
    if (this.jobs.has(id)) {
      let n = 2;
      while (this.jobs.has(`${id}-${n}`)) n++;
      id = `${id}-${n}`;
    }
    const job: CronJob = {
      ...input,
      id,
      enabled: true,
      created: new Date().toISOString(),
      lastRun: null,
      runCount: 0,
    };
    this.jobs.set(id, job);
    this.save();
    return id;
  }

  update(id: string, patch: Partial<CronJob>): void {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`job not found: ${id}`);
    const { id: _ignoredId, ...safePatch } = patch;
    this.jobs.set(id, { ...job, ...safePatch });
    this.save();
  }

  remove(id: string): void {
    this.jobs.delete(id);
    this.save();
  }

  get(id: string): CronJob | undefined {
    return this.jobs.get(id);
  }

  list(): CronJob[] {
    return [...this.jobs.values()];
  }

  close(): void {
    this.watcher?.close();
  }
}
