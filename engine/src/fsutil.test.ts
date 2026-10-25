import { describe, test, expect, afterAll } from "bun:test";
import { chmodSync, mkdirSync, rmSync, statSync } from "fs";
import { join } from "path";
import { ensureOwnerOnlyDir } from "./fsutil";
import { makeTestDir } from "./test-tmp";

const dir = makeTestDir("fsutil-test-");

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("ensureOwnerOnlyDir", () => {
  test("creates a missing folder readable only by the owner", () => {
    const path = join(dir, "new", "nested");
    ensureOwnerOnlyDir(path);
    expect(statSync(path).mode & 0o777).toBe(0o700);
  });

  test("tightens an existing world-readable folder", () => {
    const path = join(dir, "existing");
    mkdirSync(path);
    chmodSync(path, 0o755);
    ensureOwnerOnlyDir(path);
    expect(statSync(path).mode & 0o777).toBe(0o700);
  });
});
