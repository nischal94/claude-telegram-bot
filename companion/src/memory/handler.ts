import type { MemoryStore, MemoryType, MemorySource } from "./store";
import { writeSnapshot } from "./snapshot";

interface AddBody { op: "add"; type: MemoryType; key: string; value: string; source?: MemorySource }
interface ReplaceBody { op: "replace"; type: MemoryType; key: string; value: string }
interface RemoveBody { op: "remove"; type: MemoryType; key: string }
type MemoryBody = AddBody | ReplaceBody | RemoveBody;

export function createMemoryRouter(store: MemoryStore, snapshotPath: string) {
  return {
    async handlePost(req: Request): Promise<Response> {
      let body: MemoryBody;
      try {
        body = await req.json() as MemoryBody;
      } catch {
        return Response.json({ error: "invalid JSON" }, { status: 400 });
      }

      try {
        if (body.op === "add") {
          store.add({ type: body.type, key: body.key, value: body.value, source: body.source ?? "explicit" });
        } else if (body.op === "replace") {
          store.replace({ type: body.type, key: body.key, value: body.value });
        } else if (body.op === "remove") {
          store.remove({ type: body.type, key: body.key });
        } else {
          return Response.json({ error: "unknown op" }, { status: 400 });
        }
        writeSnapshot(snapshotPath, store.getAll());
        return Response.json({ ok: true });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return Response.json({ error: msg }, { status: 422 });
      }
    },

    handleGet(): Response {
      return Response.json(store.getAll());
    },

    handleSnapshot(): Response {
      writeSnapshot(snapshotPath, store.getAll());
      return Response.json({ ok: true });
    },
  };
}
