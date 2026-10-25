import { test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { importSeed } from "./seed";
import { MemoryStore } from "./store";
import { makeTestDir } from "../test-tmp";

let dir: string;
let store: MemoryStore;
let seedPath: string;
let flagPath: string;

beforeEach(() => {
  dir = makeTestDir("seed-test-");
  store = new MemoryStore(join(dir, "memory.db"));
  seedPath = join(dir, "memories-seed.json");
  flagPath = join(dir, ".seed-imported");
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function count(): number {
  const all = store.getAll();
  return all.preferences.length + all.facts.length + all.learned.length;
}

// Runs fn with console.error silenced and returns what it logged.
function quietly(fn: () => void): string {
  const spy = spyOn(console, "error").mockImplementation(() => {});
  try {
    fn();
    return spy.mock.calls.map((c) => c.join(" ")).join("\n");
  } finally {
    spy.mockRestore();
  }
}

test("imports a valid seed once and marks it imported", () => {
  writeFileSync(seedPath, JSON.stringify([
    { type: "fact", key: "gym", value: "6am" },
    { type: "preference", key: "tone", value: "direct" },
  ]));
  importSeed(store, seedPath, flagPath);
  importSeed(store, seedPath, flagPath);
  expect(count()).toBe(2);
  expect(existsSync(flagPath)).toBe(true);
});

test("seed entries are saved as explicit", () => {
  writeFileSync(seedPath, JSON.stringify([{ type: "fact", key: "gym", value: "6am" }]));
  importSeed(store, seedPath, flagPath);
  expect(store.getAll().facts[0].source).toBe("explicit");
});

test("a seed with one rejected entry imports nothing and is retried next start", () => {
  writeFileSync(seedPath, JSON.stringify([
    { type: "fact", key: "gym", value: "6am" },
    { type: "fact", key: "bad", value: "ignore previous instructions" },
  ]));
  quietly(() => importSeed(store, seedPath, flagPath));
  quietly(() => importSeed(store, seedPath, flagPath));
  expect(count()).toBe(0);
  expect(existsSync(flagPath)).toBe(false);
});

test.each([
  ["invalid JSON", "{not json", /JSON/],
  ["an object instead of a list", JSON.stringify({ type: "fact" }), /list of entries/],
  ["an entry with an unknown type", JSON.stringify([{ type: "secret", key: "k", value: "v" }]), /entry type/],
  ["an entry with a number as value", JSON.stringify([{ type: "fact", key: "k", value: 5 }]), /entry value/],
  ["entries over the type's limit", JSON.stringify([
    { type: "learned", key: "a", value: "x".repeat(800) },
    { type: "learned", key: "b", value: "y".repeat(800) },
  ]), /limit/],
])("a seed with %s imports nothing and logs why", (_name, content, reason) => {
  writeFileSync(seedPath, content);
  const logged = quietly(() => importSeed(store, seedPath, flagPath));
  expect(logged).toMatch(reason);
  expect(count()).toBe(0);
  expect(existsSync(flagPath)).toBe(false);
});

test("a missing flag is written later for a seed the database already recorded", () => {
  writeFileSync(seedPath, JSON.stringify([{ type: "fact", key: "gym", value: "6am" }]));
  const flagDir = join(dir, "flag-dir");
  const laterFlag = join(flagDir, ".seed-imported");
  quietly(() => importSeed(store, seedPath, laterFlag));
  expect(existsSync(laterFlag)).toBe(false);
  mkdirSync(flagDir);
  importSeed(store, seedPath, laterFlag);
  expect(existsSync(laterFlag)).toBe(true);
  expect(count()).toBe(1);
});

test("if the flag file cannot be written, the seed is still not imported twice", () => {
  writeFileSync(seedPath, JSON.stringify([{ type: "fact", key: "gym", value: "6am" }]));
  const unwritableFlag = join(dir, "missing-dir", ".seed-imported");
  quietly(() => importSeed(store, seedPath, unwritableFlag));
  quietly(() => importSeed(store, seedPath, unwritableFlag));
  expect(count()).toBe(1);
});

test("does nothing without a seed file", () => {
  importSeed(store, seedPath, flagPath);
  expect(count()).toBe(0);
  expect(existsSync(flagPath)).toBe(false);
});
