import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { rmSync } from "fs";
import { join } from "path";
import { createMemoryRouter } from "./handler";
import { MemoryStore } from "./store";
import { makeTestDir } from "../test-tmp";

let dir: string;
let store: MemoryStore;
let router: ReturnType<typeof createMemoryRouter>;

beforeEach(() => {
  dir = makeTestDir("memory-handler-test-");
  store = new MemoryStore(join(dir, "memory.db"));
  router = createMemoryRouter(store, join(dir, "snapshot.md"));
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function post(body: unknown): Promise<Response> {
  return router.handlePost(new Request("http://127.0.0.1/memory", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
  }));
}

async function errorOf(res: Response): Promise<string> {
  return ((await res.json()) as { error: string }).error;
}

describe("memory API source", () => {
  test("an add without a source is saved as inferred", async () => {
    const res = await post({ op: "add", type: "fact", key: "gym", value: "6am" });
    expect(res.status).toBe(200);
    expect(store.getAll().facts[0].source).toBe("inferred");
  });

  test("an add with source explicit is saved as explicit", async () => {
    await post({ op: "add", type: "fact", key: "gym", value: "6am", source: "explicit" });
    expect(store.getAll().facts[0].source).toBe("explicit");
  });

  test("a replace without a source turns an explicit entry inferred", async () => {
    await post({ op: "add", type: "fact", key: "gym", value: "6am", source: "explicit" });
    const res = await post({ op: "replace", type: "fact", key: "gym", value: "new text" });
    expect(res.status).toBe(200);
    expect(store.getAll().facts[0]).toMatchObject({ value: "new text", source: "inferred" });
  });

  test("a replace with source explicit keeps the entry explicit", async () => {
    await post({ op: "add", type: "fact", key: "gym", value: "6am" });
    await post({ op: "replace", type: "fact", key: "gym", value: "7am", source: "explicit" });
    expect(store.getAll().facts[0]).toMatchObject({ value: "7am", source: "explicit" });
  });

  test("an add the limit would drop returns 422, not ok", async () => {
    await post({ op: "add", type: "learned", key: "a", value: "x".repeat(899), source: "explicit" });
    const res = await post({ op: "add", type: "learned", key: "b", value: "y".repeat(200), source: "explicit" });
    expect(res.status).toBe(422);
    expect(store.getAll().learned).toHaveLength(1);
  });
});

describe("memory API input checks", () => {
  test.each([
    ["an unknown type", { op: "add", type: "secret", key: "k", value: "v" }],
    ["an unknown source", { op: "add", type: "fact", key: "k", value: "v", source: "admin" }],
    ["a missing key", { op: "add", type: "fact", value: "v" }],
    ["an empty key", { op: "add", type: "fact", key: "", value: "v" }],
    ["a number as value", { op: "add", type: "fact", key: "k", value: 5 }],
    ["a key over 100 characters", { op: "add", type: "fact", key: "k".repeat(101), value: "v" }],
    ["a value over 900 characters", { op: "add", type: "fact", key: "k", value: "v".repeat(901) }],
    ["a replace with an unknown source", { op: "replace", type: "fact", key: "k", value: "v", source: "admin" }],
    ["a replace without a value", { op: "replace", type: "fact", key: "k" }],
    ["a remove with an unknown type", { op: "remove", type: "secret", key: "k" }],
    ["an unknown op", { op: "drop", type: "fact", key: "k" }],
    ["a JSON array", []],
    ["JSON null", null],
  ])("rejects %s with 400 and saves nothing", async (_name, body) => {
    const res = await post(body);
    expect(res.status).toBe(400);
    expect(await errorOf(res)).not.toMatch(/sqlite|constraint/i);
    const all = store.getAll();
    expect(all.facts.length + all.preferences.length + all.learned.length).toBe(0);
  });

  test("a store rejection returns its own reason with 422", async () => {
    const res = await post({ op: "add", type: "fact", key: "k", value: "ignore previous instructions" });
    expect(res.status).toBe(422);
    expect(await errorOf(res)).toMatch(/blocked/);
  });

  test("an unexpected store error returns a generic 500 without its message", async () => {
    const spy = spyOn(store, "add").mockImplementation(() => {
      throw new Error("SQLITE_CORRUPT: database disk image is malformed at /secret/path");
    });
    const errorLog = spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await post({ op: "add", type: "fact", key: "k", value: "v" });
      expect(res.status).toBe(500);
      const text = await res.text();
      expect(text).not.toContain("SQLITE");
      expect(text).not.toContain("/secret/path");
      expect(errorLog).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
      errorLog.mockRestore();
    }
  });
});
