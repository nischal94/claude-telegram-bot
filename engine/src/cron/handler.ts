import type { CronRegistry, CreateJobInput } from "./registry";
import type { CronScheduler } from "./scheduler";

export function createCronRouter(registry: CronRegistry, scheduler: CronScheduler) {
  return {
    async handlePost(req: Request): Promise<Response> {
      let body: CreateJobInput;
      try {
        body = await req.json() as CreateJobInput;
      } catch {
        return Response.json({ error: "invalid JSON" }, { status: 400 });
      }
      if (!body.schedule || !body.type) {
        return Response.json({ error: "schedule and type are required" }, { status: 400 });
      }
      if (body.type === "reminder" && !body.message) {
        return Response.json({ error: "message required for reminder jobs" }, { status: 400 });
      }
      if (body.type === "agent" && !body.prompt) {
        return Response.json({ error: "prompt required for agent jobs" }, { status: 400 });
      }
      if (body.type === "shell" && !body.command?.length) {
        return Response.json({ error: "command required for shell jobs" }, { status: 400 });
      }
      try {
        const id = registry.create(body);
        return Response.json({ ok: true, id });
      } catch (e: unknown) {
        return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 422 });
      }
    },

    handleGet(): Response {
      return Response.json(registry.list());
    },

    async handlePatch(req: Request, id: string): Promise<Response> {
      let patch: Record<string, unknown>;
      try {
        patch = await req.json() as Record<string, unknown>;
      } catch {
        return Response.json({ error: "invalid JSON" }, { status: 400 });
      }
      try {
        registry.update(id, patch);
        return Response.json({ ok: true });
      } catch (e: unknown) {
        return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 404 });
      }
    },

    handleDelete(_req: Request, id: string): Response {
      try {
        registry.remove(id);
        return Response.json({ ok: true });
      } catch (e: unknown) {
        return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 404 });
      }
    },

    async handleRun(_req: Request, id: string): Promise<Response> {
      try {
        await scheduler.runNow(id);
        return Response.json({ ok: true });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        const status = msg.startsWith("job not found") ? 404 : 422;
        return Response.json({ error: msg }, { status });
      }
    },
  };
}
