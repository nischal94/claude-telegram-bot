import { readFileSync, mkdirSync, watch } from "fs";
import { dirname } from "path";
import { writeOwnerOnly } from "../fsutil";

export type JobType = "reminder" | "agent" | "shell";

export const JOB_TYPES: readonly JobType[] = ["reminder", "agent", "shell"];

export interface CronJob {
  id: string;
  schedule: string;
  type: JobType;
  message?: string;   // required for reminder
  prompt?: string;    // required for agent
  command?: string[]; // required for shell
  tools?: string[];   // agent only: extra tools, set by hand in the file
  delivery: "telegram";
  enabled: boolean;
  created: string;
  lastRun: string | null;
  runCount: number;
  lastError?: string;
}

export type CreateJobInput = Omit<CronJob, "enabled" | "created" | "lastRun" | "runCount">;

function isJobRecord(value: unknown): value is CronJob {
  if (typeof value !== "object" || value === null) return false;
  const job = value as Record<string, unknown>;
  return typeof job.id === "string" && job.id.length > 0
    && typeof job.schedule === "string"
    && JOB_TYPES.includes(job.type as JobType);
}

export class CronRegistry {
  private path: string;
  private jobs: Map<string, CronJob> = new Map();
  private watcher: ReturnType<typeof watch> | null = null;
  // False after the file failed to load. Saving then would replace every job
  // on disk with whatever is in memory, so saves are refused until a later
  // load succeeds.
  private writable = true;

  constructor(registryPath: string) {
    this.path = registryPath;
    mkdirSync(dirname(registryPath), { recursive: true, mode: 0o700 });
    this.reload();
    this.watcher = watch(dirname(registryPath), { persistent: false }, (event, filename) => {
      if (filename === "cron-jobs.json") this.reload();
    });
  }

  // Reads the file again. On failure the jobs already in memory stay, and
  // saves are refused until a load succeeds.
  reload(): void {
    let raw: string;
    try {
      raw = readFileSync(this.path, "utf-8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        this.jobs = new Map();
        this.writable = true;
        return;
      }
      this.markUnreadable((err as Error).message);
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      this.markUnreadable((err as Error).message);
      return;
    }
    if (!Array.isArray(parsed) || !parsed.every(isJobRecord)) {
      this.markUnreadable("expected an array of jobs with id, schedule and a known type");
      return;
    }
    this.jobs = new Map(parsed.map((j) => [j.id, j]));
    this.writable = true;
  }

  private markUnreadable(reason: string): void {
    this.writable = false;
    console.error(`[registry] Failed to load jobs: ${reason}. Context: path=${this.path} keptInMemory=${this.jobs.size} savesRefused=true`);
  }

  private save(): void {
    if (!this.writable) {
      throw new Error(`[registry] Save refused: the jobs file failed to load, and saving would overwrite it. Context: path=${this.path}`);
    }
    writeOwnerOnly(this.path, JSON.stringify([...this.jobs.values()], null, 2));
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
    try {
      this.save();
    } catch (e) {
      this.jobs.delete(id);
      throw e;
    }
    return id;
  }

  update(id: string, patch: Partial<CronJob>): void {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`job not found: ${id}`);
    const { id: _ignoredId, ...safePatch } = patch;
    this.jobs.set(id, { ...job, ...safePatch });
    try {
      this.save();
    } catch (e) {
      this.jobs.set(id, job);
      throw e;
    }
  }

  // Returns false when no job has this id.
  remove(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job) return false;
    this.jobs.delete(id);
    try {
      this.save();
    } catch (e) {
      this.jobs.set(id, job);
      throw e;
    }
    return true;
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
