import { test, expect, afterAll } from "bun:test";
import { chmodSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { join } from "path";
import { writeSnapshot } from "./snapshot";
import { makeTestDir } from "../test-tmp";

const dir = makeTestDir("snapshot-test-");
const memories = { preferences: [{ key: "tone", value: "direct" }], facts: [], learned: [] };

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("writes the snapshot readable only by the owner", () => {
  const path = join(dir, "snapshot.md");
  writeSnapshot(path, memories as any);
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(readFileSync(path, "utf-8")).toContain("- tone: direct");
});

test("replaces an existing world-readable snapshot with an owner-only one", () => {
  const path = join(dir, "old-snapshot.md");
  writeFileSync(path, "old");
  chmodSync(path, 0o644);
  writeSnapshot(path, memories as any);
  expect(statSync(path).mode & 0o777).toBe(0o600);
});
