import {
  MAX_KEY_LENGTH, MAX_VALUE_LENGTH, MEMORY_TYPES, MemoryRejected,
  type MemoryStore, type MemoryType, type MemorySource,
} from "./store";
import { writeSnapshot } from "./snapshot";

interface AddBody { op: "add"; type: MemoryType; key: string; value: string; source: MemorySource }
interface ReplaceBody { op: "replace"; type: MemoryType; key: string; value: string }
interface RemoveBody { op: "remove"; type: MemoryType; key: string }
type MemoryBody = AddBody | ReplaceBody | RemoveBody;

const SOURCES = new Set<string>(["explicit", "inferred"]);

function isText(v: unknown, max: number): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= max;
}

// Returns the checked body, or the reason it was refused.
function parseBody(raw: unknown): MemoryBody | string {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return "body must be a JSON object";
  const b = raw as Record<string, unknown>;
  if (b.op !== "add" && b.op !== "replace" && b.op !== "remove") return "op must be add, replace or remove";
  if (typeof b.type !== "string" || !MEMORY_TYPES.has(b.type)) return "type must be preference, fact or learned";
  if (!isText(b.key, MAX_KEY_LENGTH)) return `key must be a string of 1 to ${MAX_KEY_LENGTH} characters`;
  const type = b.type as MemoryType;
  if (b.op === "remove") return { op: "remove", type, key: b.key };
  if (!isText(b.value, MAX_VALUE_LENGTH)) return `value must be a string of 1 to ${MAX_VALUE_LENGTH} characters`;
  if (b.op === "replace") return { op: "replace", type, key: b.key, value: b.value };
  // A write that does not say the user asked for it counts as inferred, so it
  // stays out of the system prompt (see snapshot.ts).
  const source = b.source ?? "inferred";
  if (typeof source !== "string" || !SOURCES.has(source)) return "source must be explicit or inferred";
  return { op: "add", type, key: b.key, value: b.value, source: source as MemorySource };
}

export function createMemoryRouter(store: MemoryStore, snapshotPath: string) {
  return {
    async handlePost(req: Request): Promise<Response> {
      let raw: unknown;
      try {
        raw = await req.json();
      } catch {
        return Response.json({ error: "invalid JSON" }, { status: 400 });
      }
      const body = parseBody(raw);
      if (typeof body === "string") return Response.json({ error: body }, { status: 400 });

      try {
        if (body.op === "add") {
          store.add({ type: body.type, key: body.key, value: body.value, source: body.source });
        } else if (body.op === "replace") {
          store.replace({ type: body.type, key: body.key, value: body.value });
        } else {
          store.remove({ type: body.type, key: body.key });
        }
      } catch (e: unknown) {
        if (e instanceof MemoryRejected) return Response.json({ error: e.message }, { status: 422 });
        // Other errors can quote SQLite or file details: log them, return a
        // generic reason.
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[memory] Write failed: ${msg}. Context: op=${body.op} type=${body.type}`);
        return Response.json({ error: "memory write failed" }, { status: 500 });
      }

      try {
        writeSnapshot(snapshotPath, store.getAll());
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[memory] Failed to write snapshot: ${msg}`);
        return Response.json({ error: "snapshot write failed" }, { status: 500 });
      }

      return Response.json({ ok: true });
    },

    handleGet(): Response {
      return Response.json(store.getAll());
    },

    handleSnapshot(): Response {
      try {
        writeSnapshot(snapshotPath, store.getAll());
        return Response.json({ ok: true });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[memory] Failed to write snapshot: ${msg}`);
        return Response.json({ error: "snapshot write failed" }, { status: 500 });
      }
    },
  };
}
