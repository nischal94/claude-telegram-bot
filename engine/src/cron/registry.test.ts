import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { CronRegistry, isJobRecord, RegistryConflictError, type LoadState } from "./registry";

let tmpDir: string;
let registry: CronRegistry;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "cron-test-"));
  registry = new CronRegistry(join(tmpDir, "cron-jobs.json"));
});

afterEach(() => {
  registry.close();
  rmSync(tmpDir, { recursive: true });
});

describe("CronRegistry", () => {
  test("starts empty", () => {
    expect(registry.list()).toHaveLength(0);
  });

  test("creates a reminder job", () => {
    const id = registry.create({
      id: "test-job",
      schedule: "0 9 * * 1",
      type: "reminder",
      message: "Hello!",
      delivery: "telegram",
    });
    expect(id).toBe("test-job");
    expect(registry.list()).toHaveLength(1);
  });

  test("deduplicates ids with suffix", () => {
    registry.create({ id: "job", schedule: "0 9 * * 1", type: "reminder", message: "A", delivery: "telegram" });
    const id2 = registry.create({ id: "job", schedule: "0 9 * * 1", type: "reminder", message: "B", delivery: "telegram" });
    expect(id2).toBe("job-2");
  });

  test("updates enabled flag", () => {
    registry.create({ id: "job", schedule: "0 9 * * 1", type: "reminder", message: "A", delivery: "telegram" });
    registry.update("job", { enabled: false });
    expect(registry.get("job")?.enabled).toBe(false);
  });

  test("removes a job", () => {
    registry.create({ id: "job", schedule: "0 9 * * 1", type: "reminder", message: "A", delivery: "telegram" });
    registry.remove("job");
    expect(registry.list()).toHaveLength(0);
  });

  test("persists to disk and reloads", () => {
    registry.create({ id: "job", schedule: "0 9 * * 1", type: "reminder", message: "A", delivery: "telegram" });
    const registry2 = new CronRegistry(join(tmpDir, "cron-jobs.json"));
    expect(registry2.list()).toHaveLength(1);
    registry2.close();
  });

  test("create shell job with command array", () => {
    const id = registry.create({
      id: "my-shell-job",
      schedule: "0 9 * * 1",
      type: "shell",
      command: ["/usr/bin/bun", "run", "/abs/path/script.ts"],
      delivery: "telegram",
    });
    const job = registry.get(id)!;
    expect(job.type).toBe("shell");
    expect(job.command).toEqual(["/usr/bin/bun", "run", "/abs/path/script.ts"]);
  });

  test("remove reports whether the job existed", () => {
    registry.create({ id: "job", schedule: "0 9 * * 1", type: "reminder", message: "A", delivery: "telegram" });
    expect(registry.remove("job")).toBe(true);
    expect(registry.remove("job")).toBe(false);
  });
});

describe("CronRegistry persistence", () => {
  const job = { id: "job", schedule: "0 9 * * 1", type: "reminder" as const, message: "A", delivery: "telegram" as const };

  test("saves the registry file readable only by the owner, with no temp file left", () => {
    registry.create(job);
    const path = join(tmpDir, "cron-jobs.json");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readdirSync(tmpDir)).toEqual(["cron-jobs.json"]);
  });

  test("a corrupt file at startup keeps an empty list and refuses to overwrite the file", () => {
    const path = join(tmpDir, "cron-jobs.json");
    writeFileSync(path, "[{\"id\": \"half-writ");
    const reg = new CronRegistry(path);
    try {
      expect(reg.list()).toHaveLength(0);
      expect(() => reg.create(job)).toThrow();
      expect(readFileSync(path, "utf-8")).toBe("[{\"id\": \"half-writ");
    } finally {
      reg.close();
    }
  });

  test("a non-array file is treated as corrupt", () => {
    const path = join(tmpDir, "cron-jobs.json");
    writeFileSync(path, "{\"id\": \"job\"}");
    const reg = new CronRegistry(path);
    try {
      expect(reg.list()).toHaveLength(0);
      expect(() => reg.create(job)).toThrow();
    } finally {
      reg.close();
    }
  });

  test("a failed reload keeps the jobs already loaded", () => {
    registry.create(job);
    writeFileSync(join(tmpDir, "cron-jobs.json"), "not json");
    registry.reload();
    expect(registry.get("job")).toBeDefined();
    expect(() => registry.update("job", { enabled: false })).toThrow();
  });

  test("replaces an existing world-readable file with an owner-only one", () => {
    const path = join(tmpDir, "cron-jobs.json");
    writeFileSync(path, "[]");
    chmodSync(path, 0o644);
    registry.reload();
    registry.create(job);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test("a bad element in an otherwise valid array is treated as corrupt", () => {
    registry.create(job);
    const path = join(tmpDir, "cron-jobs.json");
    const jobs = JSON.parse(readFileSync(path, "utf-8"));
    jobs.push({ id: "broken" });
    writeFileSync(path, JSON.stringify(jobs));
    registry.reload();
    expect(registry.get("broken")).toBeUndefined();
    expect(registry.isWritable()).toBe(false);
  });

  test("a good reload after a bad one allows saving again", () => {
    registry.create(job);
    const path = join(tmpDir, "cron-jobs.json");
    const good = readFileSync(path, "utf-8");
    writeFileSync(path, "not json");
    registry.reload();
    writeFileSync(path, good);
    registry.reload();
    registry.update("job", { enabled: false });
    expect(registry.get("job")?.enabled).toBe(false);
  });

  test("a hand edit not yet reloaded is never overwritten by a save", () => {
    registry.create(job);
    const path = join(tmpDir, "cron-jobs.json");
    const edited = JSON.parse(readFileSync(path, "utf-8"));
    edited[0].message = "edited by hand";
    const editedText = JSON.stringify(edited);
    writeFileSync(path, editedText);
    // No reload yet: the watcher has not fired.
    expect(() => registry.update("job", { enabled: false })).toThrow(RegistryConflictError);
    expect(readFileSync(path, "utf-8")).toBe(editedText);
    expect(registry.get("job")?.message).toBe("edited by hand");
    registry.update("job", { enabled: false });
    expect(registry.get("job")).toMatchObject({ message: "edited by hand", enabled: false });
  });

  test("a file that disappears after loading is treated as unreadable", () => {
    registry.create(job);
    rmSync(join(tmpDir, "cron-jobs.json"));
    registry.reload();
    expect(registry.get("job")).toBeDefined();
    expect(registry.isWritable()).toBe(false);
  });

  test("duplicate ids and dot-only ids in the file are treated as corrupt", () => {
    const path = join(tmpDir, "cron-jobs.json");
    const rec = { ...job, enabled: true, created: "x", lastRun: null, runCount: 0 };
    writeFileSync(path, JSON.stringify([rec, { ...rec, message: "B" }]));
    registry.reload();
    expect(registry.isWritable()).toBe(false);
    writeFileSync(path, JSON.stringify([{ ...rec, id: ".." }]));
    registry.reload();
    expect(registry.isWritable()).toBe(false);
  });

  test("a repeated 64-character id gets a suffixed id that still loads", () => {
    const long = "a".repeat(64);
    registry.create({ ...job, id: long });
    const second = registry.create({ ...job, id: long });
    expect(second.length).toBeLessThanOrEqual(64);
    expect(second.endsWith("-2")).toBe(true);
    registry.reload();
    expect(registry.isWritable()).toBe(true);
    expect(registry.list()).toHaveLength(2);
  });

  test("a job recreated with the same id gets a different created value", () => {
    registry.create(job);
    const first = registry.get("job")!.created;
    registry.remove("job");
    registry.create(job);
    expect(registry.get("job")!.created).not.toBe(first);
  });

  test("reports the change to unreadable and back, once each", () => {
    const states: LoadState[] = [];
    const path = join(tmpDir, "watched.json");
    const reg = new CronRegistry(path, { onLoadStateChange: (s) => { states.push(s); } });
    try {
      writeFileSync(path, "not json");
      reg.reload();
      reg.reload();
      writeFileSync(path, "[]");
      reg.reload();
      reg.reload();
      expect(states).toEqual(["unreadable", "recovered"]);
    } finally {
      reg.close();
    }
  });
});

describe("CronRegistry rolls back a change whose save failed", () => {
  // A read-only directory makes the save fail. Root ignores directory
  // permissions, so these cannot run as root.
  const asRoot = process.getuid?.() === 0;
  const job = { id: "job", schedule: "0 9 * * 1", type: "reminder" as const, message: "A", delivery: "telegram" as const };

  test.skipIf(asRoot)("create, update and remove leave memory as it was", () => {
    registry.create(job);
    chmodSync(tmpDir, 0o500);
    try {
      expect(() => registry.create({ ...job, id: "new" })).toThrow();
      expect(registry.get("new")).toBeUndefined();
      expect(() => registry.update("job", { enabled: false })).toThrow();
      expect(registry.get("job")?.enabled).toBe(true);
      expect(() => registry.remove("job")).toThrow();
      expect(registry.get("job")).toBeDefined();
    } finally {
      chmodSync(tmpDir, 0o700);
    }
  });
});

describe("isJobRecord", () => {
  const base = { id: "j", schedule: "0 9 * * 1", delivery: "telegram", enabled: true, created: "x", lastRun: null, runCount: 0 };

  test("accepts each well-formed job type", () => {
    expect(isJobRecord({ ...base, type: "reminder", message: "hi" })).toBe(true);
    expect(isJobRecord({ ...base, type: "agent", prompt: "p" })).toBe(true);
    expect(isJobRecord({ ...base, type: "agent", prompt: "p", tools: ["Read"] })).toBe(true);
    expect(isJobRecord({ ...base, type: "shell", command: ["/bin/echo", "hi"] })).toBe(true);
    expect(isJobRecord({ ...base, type: "shell", command: ["/bin/printf", ""] })).toBe(true);
  });

  test("rejects the hand-edit mistakes that would change what runs", () => {
    expect(isJobRecord({ ...base, enabled: "false", type: "reminder", message: "hi" })).toBe(false);
    expect(isJobRecord({ ...base, type: "reminder" })).toBe(false);
    expect(isJobRecord({ ...base, type: "agent" })).toBe(false);
    expect(isJobRecord({ ...base, type: "agent", prompt: "p", tools: "Bash" })).toBe(false);
    expect(isJobRecord({ ...base, type: "agent", prompt: "p", tools: ["Read,Bash"] })).toBe(false);
    expect(isJobRecord({ ...base, type: "shell", command: "ls -la" })).toBe(false);
    expect(isJobRecord({ ...base, type: "shell", command: [] })).toBe(false);
    expect(isJobRecord({ ...base, type: "shell", command: ["", "x"] })).toBe(false);
    expect(isJobRecord({ ...base, type: "shell", command: ["/bin/echo", 1] })).toBe(false);
    expect(isJobRecord({ ...base, type: "script", prompt: "p" })).toBe(false);
  });
});
