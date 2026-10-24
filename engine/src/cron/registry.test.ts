import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { CronRegistry } from "./registry";

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
});
