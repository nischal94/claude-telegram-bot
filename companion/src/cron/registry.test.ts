import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
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
});
