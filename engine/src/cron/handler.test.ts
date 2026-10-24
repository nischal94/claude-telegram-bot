import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { CronRegistry } from "./registry";
import { createCronRouter } from "./handler";
import type { CronScheduler } from "./scheduler";

let tmpDir: string;
let registry: CronRegistry;
let queued: string[];
let router: ReturnType<typeof createCronRouter>;

const fakeScheduler = {
  runNow(id: string): void {
    if (!registry.get(id)) throw new Error(`job not found: ${id}`);
    queued.push(id);
  },
} as unknown as CronScheduler;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "cron-handler-test-"));
  registry = new CronRegistry(join(tmpDir, "cron-jobs.json"));
  queued = [];
  router = createCronRouter(registry, fakeScheduler);
});

afterEach(() => {
  registry.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

function post(body: unknown): Promise<Response> {
  return router.handlePost(new Request("http://127.0.0.1/cron", { method: "POST", body: JSON.stringify(body) }));
}

function patch(id: string, body: unknown): Promise<Response> {
  return router.handlePatch(new Request(`http://127.0.0.1/cron/${id}`, { method: "PATCH", body: JSON.stringify(body) }), id);
}

const reminder = { id: "standup", schedule: "0 9 * * 1", type: "reminder", message: "Standup", delivery: "telegram" };
const agent = { id: "digest", schedule: "0 8 * * *", type: "agent", prompt: "Summarise the news", delivery: "telegram" };

describe("POST /cron validation", () => {
  test("creates a valid reminder job", async () => {
    const res = await post(reminder);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, id: "standup" });
  });

  test("creates a valid agent job", async () => {
    expect((await post(agent)).status).toBe(200);
    expect(registry.get("digest")?.type).toBe("agent");
  });

  test("rejects a JSON null body with 400", async () => {
    expect((await post(null)).status).toBe(400);
  });

  test("rejects a JSON array body with 400", async () => {
    expect((await post([reminder])).status).toBe(400);
  });

  test("rejects a missing id with 400 and stores nothing", async () => {
    const { id: _id, ...noId } = reminder;
    expect((await post(noId)).status).toBe(400);
    expect(registry.list()).toHaveLength(0);
  });

  test("rejects an id with characters outside letters, digits, dot, dash and underscore", async () => {
    expect((await post({ ...reminder, id: "../etc" })).status).toBe(400);
    expect((await post({ ...reminder, id: "has space" })).status).toBe(400);
  });

  test("rejects shell jobs: they can only be added to cron-jobs.json by hand", async () => {
    const res = await post({ id: "sh", schedule: "0 9 * * 1", type: "shell", command: ["/bin/echo", "hi"], delivery: "telegram" });
    expect(res.status).toBe(400);
    expect(registry.get("sh")).toBeUndefined();
  });

  test("rejects an unknown job type with 400", async () => {
    expect((await post({ ...reminder, type: "script" })).status).toBe(400);
  });

  test("rejects an invalid cron expression with 400", async () => {
    expect((await post({ ...reminder, schedule: "every monday" })).status).toBe(400);
  });

  test("rejects a reminder without a message, and an agent job without a prompt", async () => {
    expect((await post({ ...reminder, message: "" })).status).toBe(400);
    expect((await post({ ...agent, prompt: undefined })).status).toBe(400);
  });

  test("ignores fields the API does not accept, such as command and tools", async () => {
    const res = await post({ ...agent, command: ["/bin/sh"], tools: ["Bash"], enabled: false });
    expect(res.status).toBe(200);
    const job = registry.get("digest")!;
    expect(job.command).toBeUndefined();
    expect(job.tools).toBeUndefined();
    expect(job.enabled).toBe(true);
  });

  test("a registry that cannot save returns 500 without internal details", async () => {
    registry.close();
    const path = join(tmpDir, "cron-jobs.json");
    writeFileSync(path, "corrupt");
    registry = new CronRegistry(path);
    router = createCronRouter(registry, fakeScheduler);
    const res = await post(reminder);
    expect(res.status).toBe(500);
    const body = await res.json() as { error: string };
    expect(body.error).not.toContain(tmpDir);
  });
});

describe("PATCH /cron/:id validation", () => {
  beforeEach(async () => {
    await post(reminder);
  });

  test("pauses a job", async () => {
    expect((await patch("standup", { enabled: false })).status).toBe(200);
    expect(registry.get("standup")?.enabled).toBe(false);
  });

  test("changes the schedule and message", async () => {
    expect((await patch("standup", { schedule: "30 9 * * 1", message: "Later standup" })).status).toBe(200);
    expect(registry.get("standup")?.schedule).toBe("30 9 * * 1");
    expect(registry.get("standup")?.message).toBe("Later standup");
  });

  test("rejects fields outside enabled, schedule, message and prompt", async () => {
    for (const body of [{ type: "shell" }, { command: ["/bin/sh"] }, { tools: ["Bash"] }, { runCount: 99 }]) {
      expect((await patch("standup", body)).status).toBe(400);
    }
    const job = registry.get("standup")!;
    expect(job.type).toBe("reminder");
    expect(job.command).toBeUndefined();
    expect(job.runCount).toBe(0);
  });

  test("rejects a non-boolean enabled, an invalid schedule, and an empty message", async () => {
    expect((await patch("standup", { enabled: "no" })).status).toBe(400);
    expect((await patch("standup", { schedule: "soon" })).status).toBe(400);
    expect((await patch("standup", { message: "" })).status).toBe(400);
    expect(registry.get("standup")?.enabled).toBe(true);
  });

  test("rejects a JSON null body with 400", async () => {
    expect((await patch("standup", null)).status).toBe(400);
  });

  test("returns 404 for an unknown job", async () => {
    expect((await patch("nope", { enabled: false })).status).toBe(404);
  });
});

describe("DELETE and run", () => {
  test("DELETE of an unknown job returns 404", async () => {
    const res = router.handleDelete(new Request("http://127.0.0.1/cron/nope", { method: "DELETE" }), "nope");
    expect(res.status).toBe(404);
  });

  test("run queues an existing job and says so", async () => {
    await post(reminder);
    const res = await router.handleRun(new Request("http://127.0.0.1/cron/standup/run", { method: "POST" }), "standup");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, queued: true });
    expect(queued).toEqual(["standup"]);
  });

  test("run of an unknown job returns 404", async () => {
    const res = await router.handleRun(new Request("http://127.0.0.1/cron/nope/run", { method: "POST" }), "nope");
    expect(res.status).toBe(404);
  });
});
