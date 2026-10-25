import { test, expect, afterAll } from "bun:test";
import { rmSync } from "fs";
import { join } from "path";
import { makeTestDir } from "./test-tmp";

// Runs the bash regression tests for bin/watchdog.sh, so the engine-tests
// CI check covers the watchdog too.
const SCRIPT = join(import.meta.dir, "..", "..", "tests", "watchdog.test.sh");
const tmp = makeTestDir("watchdog-script-");

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

test("bin/watchdog.sh passes its regression tests", () => {
  const result = Bun.spawnSync(["/bin/bash", SCRIPT], {
    env: { PATH: "/usr/bin:/bin", TMPDIR: tmp },
  });
  const output = result.stdout.toString();
  expect(output).not.toContain("FAIL");
  expect(output).toContain("all tests passed");
  expect(result.exitCode).toBe(0);
  // The script starts hundreds of stub processes and takes about 40 s.
}, 120_000);
