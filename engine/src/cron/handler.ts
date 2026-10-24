import cron from "node-cron";
import type { CronRegistry, CreateJobInput, CronJob } from "./registry";
import type { CronScheduler } from "./scheduler";

const ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const PATCHABLE_FIELDS = new Set(["enabled", "schedule", "message", "prompt"]);

type Validation<T> = { ok: true; value: T } | { ok: false; error: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

// Builds a job only from the fields the API accepts. Shell jobs and agent
// tools run with the owner's full authority, so they can only be added to
// cron-jobs.json by hand.
function validateNewJob(body: unknown): Validation<CreateJobInput> {
  if (!isPlainObject(body)) return { ok: false, error: "body must be a JSON object" };
  const { id, schedule, type, message, prompt } = body;
  if (typeof id !== "string" || !ID_PATTERN.test(id)) {
    return { ok: false, error: "id must be 1-64 letters, digits, '.', '_' or '-'" };
  }
  if (typeof schedule !== "string" || !cron.validate(schedule)) {
    return { ok: false, error: "schedule must be a valid cron expression" };
  }
  if (type === "shell") {
    return { ok: false, error: "shell jobs can only be added to cron-jobs.json by hand" };
  }
  if (type === "reminder") {
    if (!isNonEmptyString(message)) return { ok: false, error: "message required for reminder jobs" };
    return { ok: true, value: { id, schedule, type, message, delivery: "telegram" } };
  }
  if (type === "agent") {
    if (!isNonEmptyString(prompt)) return { ok: false, error: "prompt required for agent jobs" };
    return { ok: true, value: { id, schedule, type, prompt, delivery: "telegram" } };
  }
  return { ok: false, error: "type must be reminder or agent" };
}

function validatePatch(job: CronJob, body: unknown): Validation<Partial<CronJob>> {
  if (!isPlainObject(body)) return { ok: false, error: "body must be a JSON object" };
  const unknownFields = Object.keys(body).filter((k) => !PATCHABLE_FIELDS.has(k));
  if (unknownFields.length > 0) {
    return { ok: false, error: `only enabled, schedule, message and prompt can be changed; got ${unknownFields.join(", ")}` };
  }
  const patch: Partial<CronJob> = {};
  if ("enabled" in body) {
    if (typeof body.enabled !== "boolean") return { ok: false, error: "enabled must be true or false" };
    patch.enabled = body.enabled;
  }
  if ("schedule" in body) {
    if (typeof body.schedule !== "string" || !cron.validate(body.schedule)) {
      return { ok: false, error: "schedule must be a valid cron expression" };
    }
    patch.schedule = body.schedule;
  }
  if ("message" in body) {
    if (job.type !== "reminder") return { ok: false, error: "message applies to reminder jobs only" };
    if (!isNonEmptyString(body.message)) return { ok: false, error: "message must be a non-empty string" };
    patch.message = body.message;
  }
  if ("prompt" in body) {
    if (job.type !== "agent") return { ok: false, error: "prompt applies to agent jobs only" };
    if (!isNonEmptyString(body.prompt)) return { ok: false, error: "prompt must be a non-empty string" };
    patch.prompt = body.prompt;
  }
  return { ok: true, value: patch };
}

// Logs the real failure and returns a generic 500, so file paths and other
// internal detail never reach the API caller.
function internalError(operation: string, id: string, e: unknown): Response {
  const reason = e instanceof Error ? e.message : String(e);
  console.error(`[cron] ${operation} failed: ${reason}. Context: id=${id}`);
  return Response.json({ error: `could not ${operation}` }, { status: 500 });
}

async function readJson(req: Request): Promise<Validation<unknown>> {
  try {
    return { ok: true, value: await req.json() };
  } catch {
    return { ok: false, error: "invalid JSON" };
  }
}

export function createCronRouter(registry: CronRegistry, scheduler: CronScheduler) {
  return {
    async handlePost(req: Request): Promise<Response> {
      const body = await readJson(req);
      if (!body.ok) return Response.json({ error: body.error }, { status: 400 });
      const input = validateNewJob(body.value);
      if (!input.ok) return Response.json({ error: input.error }, { status: 400 });
      try {
        const id = registry.create(input.value);
        return Response.json({ ok: true, id });
      } catch (e: unknown) {
        return internalError("save the job", input.value.id, e);
      }
    },

    handleGet(): Response {
      return Response.json(registry.list());
    },

    async handlePatch(req: Request, id: string): Promise<Response> {
      const job = registry.get(id);
      if (!job) return Response.json({ error: "job not found" }, { status: 404 });
      const body = await readJson(req);
      if (!body.ok) return Response.json({ error: body.error }, { status: 400 });
      const patch = validatePatch(job, body.value);
      if (!patch.ok) return Response.json({ error: patch.error }, { status: 400 });
      try {
        registry.update(id, patch.value);
        return Response.json({ ok: true });
      } catch (e: unknown) {
        return internalError("update the job", id, e);
      }
    },

    handleDelete(_req: Request, id: string): Response {
      try {
        if (!registry.remove(id)) return Response.json({ error: "job not found" }, { status: 404 });
        return Response.json({ ok: true });
      } catch (e: unknown) {
        return internalError("delete the job", id, e);
      }
    },

    // Queues the job and returns at once; the run's result is reported
    // through Telegram and the job's lastRun / lastError fields.
    async handleRun(_req: Request, id: string): Promise<Response> {
      if (!registry.get(id)) return Response.json({ error: "job not found" }, { status: 404 });
      try {
        scheduler.runNow(id);
        return Response.json({ ok: true, queued: true });
      } catch (e: unknown) {
        return internalError("queue the job", id, e);
      }
    },
  };
}
