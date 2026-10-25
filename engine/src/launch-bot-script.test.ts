import { test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const LAUNCH_BOT = join(import.meta.dir, "..", "..", "deploy", "launch_bot.sh");

// Checked in the script text, not by running it: running it would start the
// real bot. The tmux server runs with umask 022, so the bot gets its owner-only
// umask from this script, before it starts claude.
test("launch_bot.sh sets umask 077 before it starts claude", () => {
  const lines = readFileSync(LAUNCH_BOT, "utf-8").split("\n");
  const umaskLine = lines.findIndex((l) => l.trim() === "umask 077");
  const execLine = lines.findIndex((l) => l.trim().startsWith("exec claude"));
  expect(umaskLine).toBeGreaterThanOrEqual(0);
  expect(execLine).toBeGreaterThan(umaskLine);
});
