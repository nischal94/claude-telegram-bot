import { readFileSync, mkdirSync, watch } from "fs";
import { dirname } from "path";
import { writeOwnerOnly } from "../fsutil";

export const JOB_TYPES = ["reminder", "agent", "shell"] as const;
export type JobType = (typeof JOB_TYPES)[number];

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

// The fields that may change after a job is created. A job's type, command
// and tools are fixed: to change them, edit cron-jobs.json by hand.
export type JobPatch = Partial<Pick<CronJob, "enabled" | "schedule" | "message" | "prompt" | "lastRun" | "runCount" | "lastError">>;

export type LoadState = "unreadable" | "recovered";

// A job id is also a URL path segment, so "." and ".." are not allowed:
// URL parsing would turn them into other paths.
const ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
export function isValidJobId(id: unknown): id is string {
  return typeof id === "string" && ID_PATTERN.test(id) && !/^\.+$/.test(id);
}

// Thrown when cron-jobs.json changed on disk since the engine last read or
// wrote it. The engine reloads the file and refuses the save, so an edit
// made by hand is never overwritten by stale state.
export class RegistryConflictError extends Error {}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isNonEmptyString);
}

// Checks every field the engine relies on, including the per-type ones.
// cron-jobs.json is the only source of shell jobs and extra agent tools,
// and a hand edit can get a type wrong (for example "enabled": "false").
export function isJobRecord(value: unknown): value is CronJob {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const job = value as Record<string, unknown>;
  const base = isValidJobId(job.id)
    && typeof job.schedule === "string"
    && typeof job.enabled === "boolean"
    && typeof job.created === "string"
    && typeof job.runCount === "number" && Number.isFinite(job.runCount)
    && (job.lastRun === null || typeof job.lastRun === "string")
    && (job.lastError === undefined || typeof job.lastError === "string");
  if (!base) return false;
  switch (job.type) {
    case "reminder":
      return isNonEmptyString(job.message);
    case "agent":
      return isNonEmptyString(job.prompt)
        && (job.tools === undefined || (isStringArray(job.tools) && !job.tools.some((t) => t.includes(","))));
    case "shell":
      // The program must be named; later arguments may be empty strings.
      return Array.isArray(job.command)
        && isNonEmptyString(job.command[0])
        && job.command.every((a) => typeof a === "string");
    default:
      return false;
  }
}

export interface RegistryOptions {
  // Called when the file becomes unreadable, and again when it loads after
  // that. Not called for the first successful load.
  onLoadStateChange?: (state: LoadState, reason?: string) => void;
}

export class CronRegistry {
  private path: string;
  private jobs: Map<string, CronJob> = new Map();
  private watcher: ReturnType<typeof watch> | null = null;
  private onLoadStateChange?: RegistryOptions["onLoadStateChange"];
  // False after the file failed to load. Saving then would replace every job
  // on disk with whatever is in memory, so saves are refused until a later
  // load succeeds.
  private writable = true;
  // The file's content as last loaded or saved by the engine, or null when
  // there was no file. A save first checks the file still matches it.
  private diskContent: string | null = null;
  // Keeps `created` strictly increasing, so it identifies one instance of a
  // job even when a job is deleted and recreated with the same id at once.
  private lastCreatedMs = 0;

  constructor(registryPath: string, options: RegistryOptions = {}) {
    this.path = registryPath;
    this.onLoadStateChange = options.onLoadStateChange;
    mkdirSync(dirname(registryPath), { recursive: true, mode: 0o700 });
    this.reload();
    this.watcher = watch(dirname(registryPath), { persistent: false }, (event, filename) => {
      if (filename === "cron-jobs.json") this.reload();
    });
    // On Linux the watcher can report an error for the temp file of an atomic
    // save that was already renamed away. Without a listener that error is
    // thrown and stops the engine. The folder watch keeps working, so log it.
    this.watcher.on("error", (err: Error) => {
      console.warn(`[registry] File watcher error: ${err.message}. Context: path=${this.path}`);
    });
  }

  isWritable(): boolean {
    return this.writable;
  }

  // Reads the file again. On failure the jobs already in memory stay, and
  // saves are refused until a load succeeds.
  reload(): void {
    let raw: string;
    try {
      raw = readFileSync(this.path, "utf-8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        // No file yet is an empty registry. A file that disappears after it
        // was read (for example in the middle of an editor's save) is not.
        if (this.diskContent === null) this.loaded(new Map(), null);
        else this.markUnreadable("the file is missing");
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
    if (!Array.isArray(parsed)) {
      this.markUnreadable("expected an array of jobs");
      return;
    }
    const bad = parsed.findIndex((j) => !isJobRecord(j));
    if (bad !== -1) {
      this.markUnreadable(`job at index ${bad} is missing a field or has a field of the wrong type`);
      return;
    }
    const jobs = new Map((parsed as CronJob[]).map((j) => [j.id, j]));
    if (jobs.size !== parsed.length) {
      this.markUnreadable("two or more jobs share an id");
      return;
    }
    this.loaded(jobs, raw);
  }

  private loaded(jobs: Map<string, CronJob>, content: string | null): void {
    this.jobs = jobs;
    this.diskContent = content;
    if (!this.writable) {
      this.writable = true;
      console.log(`[registry] Jobs file loads again; saves allowed. Context: path=${this.path}`);
      this.onLoadStateChange?.("recovered");
    }
  }

  private markUnreadable(reason: string): void {
    const changed = this.writable;
    this.writable = false;
    console.error(`[registry] Failed to load jobs: ${reason}. Context: path=${this.path} keptInMemory=${this.jobs.size} savesRefused=true`);
    if (changed) this.onLoadStateChange?.("unreadable", reason);
  }

  private readDisk(): string | null {
    try {
      return readFileSync(this.path, "utf-8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  private save(): void {
    if (!this.writable) {
      throw new Error(`[registry] Save refused: the jobs file failed to load, and saving would overwrite it. Context: path=${this.path}`);
    }
    // The file watcher reports changes a little late. Check the file here so
    // a hand edit that has not been reloaded yet is not overwritten. This is
    // best-effort: an edit saved in the instant between this check and the
    // rename below is still lost; ruling that out needs a lock shared with
    // every writer.
    if (this.readDisk() !== this.diskContent) {
      this.reload();
      throw new RegistryConflictError(`[registry] Save refused: the jobs file changed on disk; reloaded it. Context: path=${this.path}`);
    }
    const content = JSON.stringify([...this.jobs.values()], null, 2);
    writeOwnerOnly(this.path, content);
    this.diskContent = content;
  }

  // Applies a change in memory and saves it. If the save fails, the change
  // is undone, unless the save reloaded the file (a conflict): the reloaded
  // jobs are then the truth, and undoing would bring stale state back.
  private commit(change: (jobs: Map<string, CronJob>) => void, undo: (jobs: Map<string, CronJob>) => void): void {
    const jobs = this.jobs;
    change(jobs);
    try {
      this.save();
    } catch (e) {
      if (this.jobs === jobs) undo(jobs);
      throw e;
    }
  }

  create(input: CreateJobInput): string {
    let id = input.id;
    if (this.jobs.has(id)) {
      // Shorten the base so the suffixed id still fits the 64-character limit.
      const withSuffix = (n: number): string => `${input.id.slice(0, 64 - `-${n}`.length)}-${n}`;
      let n = 2;
      while (this.jobs.has(withSuffix(n))) n++;
      id = withSuffix(n);
    }
    const createdMs = Math.max(Date.now(), this.lastCreatedMs + 1);
    this.lastCreatedMs = createdMs;
    const job: CronJob = {
      ...input,
      id,
      enabled: true,
      created: new Date(createdMs).toISOString(),
      lastRun: null,
      runCount: 0,
    };
    // Never save a job the loader would reject: that would make the whole
    // file unreadable on the next load.
    if (!isJobRecord(job)) {
      throw new Error(`[registry] Refusing to create an invalid job. Context: id=${JSON.stringify(id)} type=${JSON.stringify(input.type)}`);
    }
    this.commit((jobs) => jobs.set(id, job), (jobs) => jobs.delete(id));
    return id;
  }

  update(id: string, patch: JobPatch): void {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`job not found: ${id}`);
    this.commit((jobs) => jobs.set(id, { ...job, ...patch }), (jobs) => jobs.set(id, job));
  }

  // Returns false when no job has this id.
  remove(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job) return false;
    this.commit((jobs) => jobs.delete(id), (jobs) => jobs.set(id, job));
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
